import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatAgyQuotaLine, parseAgyQuota, usageFamily } from "../usage.ts";

const SAMPLE_AGY_QUOTA = [
	"Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-21T14:13:00Z",
	"Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-14T19:13:00Z",
	"Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-21T14:13:00Z",
	"Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-14T19:13:00Z",
	"Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-21T14:13:00Z",
].join("\n");

const NOW = Date.UTC(2026, 10, 14, 14, 13, 0);

test("parseAgyQuota parses Gemini Models 5h and weekly rows into an agy snapshot", () => {
	const snapshot = parseAgyQuota(SAMPLE_AGY_QUOTA, NOW);
	assert.ok(snapshot, "expected agy snapshot");
	assert.equal(snapshot.provider, "agy");
	assert.equal(snapshot.family, "agy");
	assert.equal(snapshot.fetchedAt, NOW);
	assert.deepEqual(snapshot.primary, {
		usedPercent: 0,
		resetAt: Date.parse("2026-11-14T19:13:00Z"),
		windowSeconds: 18_000,
	});
	assert.deepEqual(snapshot.secondary, {
		usedPercent: 0,
		resetAt: Date.parse("2026-11-21T14:13:00Z"),
		windowSeconds: 604_800,
	});
	assert.equal(
		formatAgyQuotaLine(snapshot, NOW),
		"agy (Gemini): 5h 0% used · 7d 0% used (reset 5h / 7d)",
	);
});

test("parseAgyQuota computes usedPercent = 100 - left", () => {
	const output = [
		"Gemini Models\tFive Hour Limit Remaining\t35%\t2026-11-14T19:13:00Z",
		"Gemini Models\tWeekly Limit Remaining\t80%\t2026-11-21T14:13:00Z",
	].join("\n");
	const snapshot = parseAgyQuota(output, NOW);
	assert.ok(snapshot);
	assert.equal(snapshot.primary?.usedPercent, 65);
	assert.equal(snapshot.secondary?.usedPercent, 20);
});

test("parseAgyQuota returns undefined for malformed or non-Gemini output", () => {
	assert.equal(parseAgyQuota("", NOW), undefined);
	assert.equal(parseAgyQuota("not a quota table", NOW), undefined);
	assert.equal(
		parseAgyQuota("Claude and GPT models\tWeekly Limit Remaining\t50%\t2026-11-21T14:13:00Z", NOW),
		undefined,
	);
	assert.equal(
		parseAgyQuota("Gemini Models\tFive Hour Limit Remaining\tbad%\t2026-11-14T19:13:00Z", NOW),
		undefined,
	);
	assert.equal(
		parseAgyQuota("Gemini Models\tFive Hour Limit Remaining\t100%\tnot-an-iso-date", NOW),
		undefined,
	);
});

test("usageFamily never treats agy as a Pi provider family", () => {
	assert.equal(usageFamily("agy"), undefined);
});

test("index.ts persists agy quota, shows it in accounts, keeps previous on failure, and never treats agy as a route candidate", async () => {
	const dir = mkdtempSync(join(tmpdir(), "multi-account-agy-quota-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	const prevOffline = process.env.PI_OFFLINE;
	const prevAgyBin = process.env.AGY_BIN;
	const prevChild = process.env.PI_SUBAGENT_CHILD;
	const prevWeb = process.env.PI_WEB_SESSION;

	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_WEB_SESSION;
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_OFFLINE = "1";

	const modeFile = join(dir, "agy-mode.txt");
	const callsFile = join(dir, "agy-calls.txt");
	writeFileSync(modeFile, "ok");

	const fakeScript = join(dir, "fake-agy.mjs");
	writeFileSync(
		fakeScript,
		`import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsFile)}, process.argv.slice(2).join(" ") + "\\n");
const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
if (mode === "fail") {
  process.stderr.write("agy failed");
  process.exit(1);
}
process.stdout.write(${JSON.stringify(SAMPLE_AGY_QUOTA)} + "\\n");
`,
	);

	const agyBin = process.platform === "win32" ? join(dir, "fake-agy.cmd") : join(dir, "fake-agy.sh");
	if (process.platform === "win32") {
		writeFileSync(agyBin, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`);
	} else {
		writeFileSync(agyBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`);
		chmodSync(agyBin, 0o755);
	}
	process.env.AGY_BIN = agyBin;

	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({
			"fixture-a": { type: "api_key", key: "fixture-only-a" },
		}),
	);
	writeFileSync(
		join(dir, "provider-failover.json"),
		JSON.stringify({
			includeCursor: false,
			childProxy: false,
			autoDiscoverModels: false,
			showUsage: true,
			includeOtherProviders: true,
			fallbacks: ["fixture-a"],
			usageStatusRefreshMs: 3_600_000,
			debugLog: true,
		}),
	);

	try {
		const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const { default: multiAccount } = await import("../index.ts");

		const model = {
			provider: "fixture-a",
			id: "model-a",
			name: "model-a",
			api: "openai-completions" as const,
			baseUrl: "http://127.0.0.1:1",
			reasoning: false,
			input: ["text" as const],
			contextWindow: 100_000,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};

		const settings = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			extensionFactories: [
				(pi) => {
					pi.registerProvider("fixture-a", {
						api: "openai-completions",
						baseUrl: model.baseUrl,
						apiKey: "fixture-only-a",
						models: [model],
						streamSimple: () => {
							throw new Error("no inference in this test");
						},
					});
				},
				multiAccount,
			],
		});
		await loader.reload();
		const created = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager: SessionManager.inMemory(dir),
			model,
			tools: [],
		});
		assert.deepEqual(created.extensionsResult.errors, []);

		const notifications: Array<{ text: string; level?: string }> = [];
		const fakeUi = {
			notify: (text: string, level?: string) => notifications.push({ text, level }),
			setStatus: () => {},
		};
		await created.session.bindExtensions({
			mode: "print",
			uiContext: fakeUi as any,
			onError: (error: any) => {
				throw new Error(JSON.stringify(error));
			},
		});

		// 1. State file persisted usageByProvider.agy
		const statePath = join(dir, "provider-failover-state.json");
		assert.ok(existsSync(statePath), "provider-failover-state.json should exist");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		assert.equal(state.usageByProvider?.agy?.provider, "agy");
		assert.equal(state.usageByProvider?.agy?.family, "agy");
		assert.equal(state.usageByProvider?.agy?.primary?.usedPercent, 0);
		assert.equal(state.usageByProvider?.agy?.secondary?.usedPercent, 0);
		assert.equal(
			state.usageByProvider?.agy?.primary?.resetAt,
			Date.parse("2026-11-14T19:13:00Z"),
		);

		// 2. agy never appears as a route/account choice candidate
		const command = created.session.extensionRunner.getCommand("multi-account");
		assert.ok(command, "multi-account command is registered");
		const completions = (await command.getArgumentCompletions?.("use ")) ?? [];
		assert.ok(
			!completions.some((item: any) => item.value === "agy" || item.label?.includes("agy")),
			`agy must never appear in route choices, got ${JSON.stringify(completions)}`,
		);

		// 3. `/multi-account accounts` displays the agy (Gemini) line
		notifications.length = 0;
		await command.handler("accounts", { ui: fakeUi, model } as any);
		assert.ok(
			notifications.some((n) => /agy \(Gemini\): 5h 0% used · 7d 0% used \(reset /.test(n.text)),
			`expected agy line in accounts output, got ${JSON.stringify(notifications)}`,
		);

		// 4. Failure on refresh logs via logEvent and preserves previous reading
		writeFileSync(modeFile, "fail");
		await command.handler("accounts refresh", { ui: fakeUi, model } as any);
		const stateAfterFail = JSON.parse(readFileSync(statePath, "utf8"));
		assert.equal(
			stateAfterFail.usageByProvider?.agy?.primary?.usedPercent,
			0,
			"previous agy reading must be preserved on failure",
		);
		const logPath = join(dir, "provider-failover-debug.log");
		const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		assert.ok(
			logText.includes("agy_quota_failed"),
			`expected agy_quota_failed in log, got ${logText}`,
		);

		// 5. Verify agy was invoked with -p=/quota
		const calls = readFileSync(callsFile, "utf8").trim().split(/\r?\n/);
		assert.ok(calls.length >= 2);
		assert.ok(calls.every((c) => c === "-p=/quota"));

		await created.session.dispose();
	} finally {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		if (prevOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = prevOffline;
		if (prevAgyBin === undefined) delete process.env.AGY_BIN;
		else process.env.AGY_BIN = prevAgyBin;
		if (prevChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = prevChild;
		if (prevWeb === undefined) delete process.env.PI_WEB_SESSION;
		else process.env.PI_WEB_SESSION = prevWeb;
	}
});
