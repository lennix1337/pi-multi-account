import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Session start reads account usage and both live model catalogs. Those reads are independent, so
// they must overlap instead of waiting for each other. A fake fetch with a fixed latency counts how
// many of them are in flight at once; the network is closed to everything else.
delete process.env.PI_WEB_SESSION;
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS;

const dir = mkdtempSync(join(tmpdir(), "multi-account-session-start-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: multiAccount } = await import("../index.ts");

const LATENCY_MS = 300;
const models = ["model-a"].map((id) => ({
  provider: "session-fixture", id, name: id, api: "openai-completions" as const,
  baseUrl: "http://127.0.0.1:1", reasoning: true, input: ["text" as const],
  contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

function familyOf(url: string): string | undefined {
  if (url.startsWith("https://chatgpt.com/backend-api/codex/models")) return "codex-catalog";
  if (url === "https://ollama.com/v1/models") return "ollama-catalog";
  if (url === "https://ollama.com/api/me") return "ollama-usage";
  if (url === "https://chatgpt.com/backend-api/wham/usage") return "codex-usage";
  return undefined;
}

async function open() {
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    extensionFactories: [(pi) => {
      pi.registerProvider("session-fixture", { api: "openai-completions", baseUrl: "http://127.0.0.1:1",
        apiKey: "fixture-only", models,
        streamSimple: (selected: any) => {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            const message: any = { role: "assistant", content: [{ type: "text", text: "OK" }],
              api: selected.api, provider: selected.provider, model: selected.id, stopReason: "stop", timestamp: Date.now(),
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            stream.push({ type: "done", reason: "stop", message }); stream.end();
          });
          return stream;
        },
      });
    }, multiAccount],
  });
  await loader.reload();
  const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
    settingsManager: settings, sessionManager: SessionManager.inMemory(dir), model: models[0], tools: [] });
  assert.deepEqual(result.extensionsResult.errors, []);
  await result.session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
  return result.session;
}

test("session start overlaps usage and both catalog reads instead of queuing the catalogs behind usage", async () => {
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    ollama: { type: "api_key", key: "fixture-only" },
    "openai-codex": { type: "oauth", access: "fixture-only", refresh: "fixture-only", expires: Date.now() + 3_600_000, accountId: "fixture-account" },
  }));
  writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
    includeCursor: false, childProxy: false, autoDiscoverModels: true, showUsage: true,
  }));
  const realFetch = globalThis.fetch;
  let inFlight = 0;
  let peak = 0;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const family = familyOf(url);
    if (!family) throw new TypeError(`offline fixture has no answer for ${url}`);
    seen.push(family);
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  try {
    const session = await open();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 4, `every startup read was attempted: ${seen.join(", ")}`);
  // Usage reads already overlap each other; the catalogs must join them instead of waiting for usage to finish.
  assert.ok(peak >= 3, `startup reads overlapped (peak ${peak} in flight; order ${seen.join(" → ")})`);
});
