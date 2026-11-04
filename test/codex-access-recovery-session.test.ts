import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Exercise Pi's real continuation dispatch without external requests or personal credentials.
const dir = mkdtempSync(join(tmpdir(), "multi-account-access-recovery-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
delete process.env.PI_SUBAGENT_CHILD;
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
	await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: multiAccount } = await import("../index.ts");

test("real Pi resumes Codex access verification failures without another user prompt", { timeout: 15_000 }, async () => {
	const provider = "access-check-fixture";
	const model = {
		provider, id: "fixture-model", name: "Access recovery fixture",
		api: "openai-completions" as const, baseUrl: "http://127.0.0.1:1",
		reasoning: false, input: ["text" as const], contextWindow: 100_000, maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "fixture-only" } }));
	writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
		includeCursor: false, childProxy: false, autoDiscoverModels: false, showUsage: false,
		includeOtherProviders: true, fallbacks: [provider], autoContinue: true,
		transientCooldownMs: 25, pendingPollMs: 25,
	}));
	const requests: string[] = [];
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true,
		extensionFactories: [
			(pi) => pi.registerProvider(provider, {
				api: model.api, baseUrl: model.baseUrl, apiKey: "fixture-only", models: [model],
				streamSimple: (selected: any) => {
					requests.push(`${selected.provider}/${selected.id}`);
					const failed = requests.length <= 2;
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						const message: any = {
							role: "assistant", content: failed ? [] : [{ type: "text", text: "RECOVERED" }],
							api: selected.api, provider: selected.provider, model: selected.id,
							stopReason: failed ? "error" : "stop", timestamp: Date.now(),
							...(failed ? { errorMessage: "Codex error: Unable to verify model access right now. Please retry." } : {}),
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						};
						if (failed) stream.push({ type: "error", reason: "error", error: message });
						else stream.push({ type: "done", reason: "stop", message });
						stream.end();
					});
					return stream;
				},
			}),
			multiAccount,
		],
	});
	await loader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
		sessionManager: SessionManager.inMemory(dir), model, tools: [],
	});
	assert.deepEqual(extensionsResult.errors, []);
	try {
		await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
		await session.prompt("Return RECOVERED after access verification becomes available");
		const deadline = Date.now() + 10_000;
		while (!session.messages.some((message: any) => message.role === "assistant" &&
			message.stopReason === "stop" && message.content.some((block: any) => block.text === "RECOVERED"))) {
			assert.ok(Date.now() < deadline, "recovery must complete without another user prompt");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.deepEqual(requests, Array(3).fill(`${provider}/${model.id}`));
		assert.equal(session.model?.provider, provider);
		assert.equal(session.model?.id, model.id);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});
