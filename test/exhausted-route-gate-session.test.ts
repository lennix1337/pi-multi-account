import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Replays the 10/11 incident with a real Pi session and stubbed provider wire APIs (no network,
// no credentials): anthropic-account-2 rate-limits, anthropic is out of credit, both Codex accounts
// are out of quota. Later turns, started by background-worker reports instead of the user, must not
// send a single request to the accounts already known to be spent.
const dir = mkdtempSync(join(tmpdir(), "multi-account-exhausted-gate-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
delete process.env.PI_SUBAGENT_CHILD; // This fixture exercises an interactive session.
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
	await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { registerApiProvider } = await import("@earendil-works/pi-ai/compat");
const { default: multiAccount } = await import("../index.ts");

const REFUSALS: Record<string, string> = {
	"anthropic-account-2":
		'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}',
	anthropic:
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
	"openai-codex": "Codex error: The usage limit has been reached",
	"openai-codex-account-2":
		"You have hit your ChatGPT usage limit (team plan). Try again in ~1129 min.",
};
const providers = Object.keys(REFUSALS);
const MODEL_ID: Record<string, string> = {
	"anthropic-account-2": "claude-opus-4-5",
	anthropic: "claude-opus-4-5",
	"openai-codex": "gpt-5.5",
	"openai-codex-account-2": "gpt-5.5",
};

const requests: string[] = [];
function refuse(model: any, _context: any, options: any) {
	// A provider handed an already-aborted signal never opens a connection.
	if (options?.signal?.aborted !== true) requests.push(model.provider);
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const aborted = options?.signal?.aborted === true;
		const message: any = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: aborted ? "aborted" : "error",
			timestamp: Date.now(),
			errorMessage: aborted ? "Operation aborted" : REFUSALS[model.provider],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
		stream.end();
	});
	return stream;
}
for (const api of ["anthropic-messages", "openai-codex-responses"]) {
	registerApiProvider({ api, stream: refuse, streamSimple: refuse } as any, "exhausted-route-gate-test");
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("turns started by background reports send no request while every account is exhausted", async () => {
	const far = Date.now() + 365 * 24 * 60 * 60 * 1000;
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({
			anthropic: { type: "api_key", key: "fixture-only-anthropic" },
			"anthropic-account-2": { type: "api_key", key: "fixture-only-anthropic-2" },
			"openai-codex": { type: "oauth", access: "a", refresh: "ar", expires: far, accountId: "codex-1" },
			"openai-codex-account-2": { type: "oauth", access: "b", refresh: "br", expires: far, accountId: "codex-2" },
		}),
	);
	writeFileSync(
		join(dir, "provider-failover.json"),
		JSON.stringify({
			includeCursor: false,
			childProxy: false,
			autoDiscoverModels: false,
			showUsage: false,
			autoContinue: true,
			resumeAfterAllAccountsRecover: true,
			pendingPollMs: 60_000,
		}),
	);

	const notices: string[] = [];
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
		extensionFactories: [multiAccount as any],
	});
	await loader.reload();
	const result = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		resourceLoader: loader,
		settingsManager: settings,
		sessionManager: SessionManager.inMemory(dir),
		tools: [],
	});
	assert.deepEqual(result.extensionsResult.errors, []);
	const session = result.session;
	const ui = new Proxy(
		{ notify: (message: string) => void notices.push(String(message)) },
		{ get: (target: any, key) => target[key] ?? (() => undefined) },
	);
	try {
		await session.bindExtensions({
			mode: "print",
			uiContext: ui as any,
			onError: (error: any) => {
				throw new Error(JSON.stringify(error));
			},
		});
		// Pi routes the Codex wire API through its own transport, not the compat registry: swap the
		// transport of both Codex accounts for the stub, keeping their registered catalogues.
		for (const id of ["openai-codex", "openai-codex-account-2"]) {
			const catalogue = session.modelRuntime.getModels(id);
			assert.ok(catalogue.length > 0, `${id} has a catalogue`);
			session.modelRuntime.registerProvider(id, {
				api: "openai-codex-responses" as any,
				baseUrl: "http://127.0.0.1:1",
				apiKey: "fixture-only",
				streamSimple: refuse as any,
				models: catalogue.map((m: any) => ({ ...m })) as any,
			});
		}
		const first = session.modelRuntime.getModel("anthropic-account-2", MODEL_ID["anthropic-account-2"]);
		assert.ok(first, `anthropic-account-2 model is registered; have ${JSON.stringify(session.modelRuntime.getModels().map((m: any) => m.provider + "/" + m.id).filter((m: string) => /account|codex|^anthropic\/claude-opus/.test(m)).slice(0, 20))}`);
		await session.setModel(first);

		// ---- the incident chain: each account refuses once, in rotation order ----
		await session.prompt("start the task");
		await waitFor(() => requests.length >= providers.length, "the failover chain to reach every account").catch((error) => {
			assert.fail(`${error.message}; requests=${JSON.stringify(requests)} notices=${JSON.stringify(notices)}`);
		});
		await sleep(150);
		assert.deepEqual(requests, providers, "each account is asked exactly once");

		const state = () => JSON.parse(readFileSync(join(dir, "provider-failover-state.json"), "utf8"));
		const cooldownMs = (provider: string) => state().exhaustedUntilByProvider?.[provider] - Date.now();
		// "credit balance is too low" is billing, not a blip: it must bench the account for hours,
		// never for the transient retry window.
		assert.ok(cooldownMs("anthropic") > 60 * 60 * 1000, `credit exhaustion must be a long cooldown, got ${cooldownMs("anthropic")}ms`);
		// A parsed "Try again in ~1129 min" is recorded (bounded by the recheck ceiling), not dropped.
		assert.ok(cooldownMs("openai-codex-account-2") > 5 * 60 * 1000, "the stated horizon must be persisted");

		// ---- background-worker reports start new turns while everything is spent ----
		const before = requests.length;
		const noticesBefore = notices.length;
		for (let turn = 0; turn < 5; turn++) {
			await session.sendCustomMessage(
				{ customType: "optchat-report", content: `worker report ${turn}`, display: true },
				{ triggerTurn: true },
			);
			await sleep(60);
		}
		assert.deepEqual(
			requests.slice(before),
			[],
			`no request may reach an exhausted account, but ${JSON.stringify(requests.slice(before))} did`,
		);
		const summaries = notices.slice(noticesBefore).filter((message) => /exhausted|cooling|no request/i.test(message));
		assert.equal(summaries.length, 1, `exactly one clear error for the five turns, got ${JSON.stringify(summaries)}`);
		for (const provider of providers) {
			assert.match(summaries[0], new RegExp(provider), `the error must name ${provider}`);
		}
		assert.match(summaries[0], /\d{2}:\d{2}/, "the error must say when the first account returns");

		// The wait for recovery must survive the refused turns.
		assert.ok(state().pendingFrom, "the pending resume stays armed so the work continues on recovery");
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});
