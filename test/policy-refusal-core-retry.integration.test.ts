import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Real Pi agent retry loop with a synthetic local provider. The provider never performs a
// network request; this checks the host retry independently from extension continuation hooks.
test("provider policy refusal aborts Pi's native agent retry", { timeout: 15000 }, async () => {
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
		await import("@earendil-works/pi-coding-agent");
	const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
	const { default: multiAccount } = await import("../index.ts");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";

	const run = async (withMultiAccount: boolean) => {
		const dir = mkdtempSync(join(tmpdir(), "multi-account-policy-retry-"));
		const model = {
			provider: "policy-fixture",
			id: "fixture-model",
			name: "Policy fixture",
			api: "openai-completions" as const,
			baseUrl: "http://127.0.0.1:1",
			reasoning: false,
			input: ["text" as const],
			contextWindow: 100_000,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const requests: string[] = [];
		let session: any;
		try {
			process.env.PI_CODING_AGENT_DIR = dir;
			process.env.PI_OFFLINE = "1";
			if (withMultiAccount) {
				writeFileSync(
					join(dir, "auth.json"),
					JSON.stringify({ "policy-fixture": { type: "api_key", key: "fixture-only" } }),
				);
				writeFileSync(
					join(dir, "provider-failover.json"),
					JSON.stringify({
						includeOtherProviders: true,
						childProxy: false,
						autoDiscoverModels: false,
						showUsage: false,
					fallbacks: ["policy-fixture"],
						autoContinue: true,
						contextGuard: false,
					}),
				);
			}
			const settings = SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
			});
			const extensions: any[] = [
				(pi: any) => {
					pi.registerProvider(model.provider, {
						api: model.api,
						baseUrl: model.baseUrl,
						apiKey: "fixture-only",
						models: [model],
						streamSimple: (selected: any) => {
							requests.push(selected.provider);
							const stream = createAssistantMessageEventStream();
						queueMicrotask(() => {
							const refusal = requests.length === 1;
							const message: any = {
								role: "assistant",
								content: refusal ? [] : [{ type: "text", text: "Recovered on Pi's retry." }],
								api: selected.api,
								provider: selected.provider,
								model: selected.id,
								stopReason: refusal ? "error" : "stop",
								timestamp: Date.now(),
								...(refusal
									? {
										errorMessage: withMultiAccount
											? "Your request was rejected as a result of our safety system. Server error 503"
											: "Server error 503",
									}
									: {}),
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 2,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							};
							if (refusal) stream.push({ type: "error", reason: "error", error: message });
							else stream.push({ type: "done", reason: "stop", message });
							stream.end();
						});
						return stream;
						},
					});
				},
				...(withMultiAccount ? [multiAccount] : []),
			];
			const loader = new DefaultResourceLoader({
				cwd: dir,
				agentDir: dir,
				settingsManager: settings,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				extensionFactories: extensions,
			});
			await loader.reload();
			const result = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				resourceLoader: loader,
				settingsManager: settings,
				sessionManager: SessionManager.inMemory(dir),
				model,
				tools: [],
			});
			assert.deepEqual(result.extensionsResult.errors, []);
			session = result.session;
			await session.bindExtensions({ mode: "print", onError: () => {} });
			try {
				await session.prompt("Complete the synthetic retry test.");
			} catch {
				// The protected policy-refusal run is expected to abort rather than retry.
			}
			return requests;
		} finally {
			if (session) {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
			rmSync(dir, { recursive: true, force: true });
		}
	};

	try {
		const controlRequests = await run(false);
		assert.equal(controlRequests.length, 2, "the configured Pi agent retry is exercised without the extension");
		const protectedRequests = await run(true);
		assert.equal(protectedRequests.length, 1, "the policy refusal aborts the host retry, not only extension continuation");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
	}
});
