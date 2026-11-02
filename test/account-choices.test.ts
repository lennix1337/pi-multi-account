import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

// `/multi-account use <Tab>` runs on every keystroke. It lists every account with its cached usage
// snapshot, and each snapshot is only valid while its credential is unchanged. The credential store
// is read ONCE per listing; each account used to re-read and re-parse auth.json and the proxy sidecar
// to check its own snapshot, so one keystroke cost N+1 reads of the same files.
delete process.env.PI_WEB_SESSION;
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS;

const dir = mkdtempSync(join(tmpdir(), "multi-account-choices-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { default: multiAccount } = await import("../index.ts");

const ACCOUNTS = 6;
const now = Date.now();
const hash12 = (input: string) => createHash("sha256").update(input).digest("hex").slice(0, 12);
const fakeToken = () => randomBytes(900).toString("base64url");

function fixtureAccounts() {
  const auth: Record<string, any> = {};
  const usage: Record<string, any> = {};
  for (let i = 0; i < ACCOUNTS; i++) {
    const id = i === 0 ? "openai-codex" : `openai-codex-${i + 1}`;
    const access = fakeToken();
    auth[id] = { type: "oauth", access, refresh: fakeToken(), expires: now + 3_600_000, accountId: `acct-${i}` };
    usage[id] = {
      provider: id, family: "codex", fetchedAt: now, credentialHash: hash12(access), plan: "plus",
      account: `user${i}@example.invalid`, serviceable: true,
      primary: { usedPercent: 10 + i, resetAt: now + 3_600_000, windowSeconds: 18_000 },
    };
  }
  return { auth, usage };
}

const models = [{
  provider: "choices-fixture", id: "model-a", name: "model-a", api: "openai-completions" as const,
  baseUrl: "http://127.0.0.1:1", reasoning: true, input: ["text" as const],
  contextWindow: 100_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}];

async function openCommand() {
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    extensionFactories: [(pi) => {
      pi.registerProvider("choices-fixture", { api: "openai-completions", baseUrl: "http://127.0.0.1:1",
        apiKey: "fixture-only", models, streamSimple: () => { throw new Error("no inference in this test"); } });
    }, multiAccount],
  });
  await loader.reload();
  const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
    settingsManager: settings, sessionManager: SessionManager.inMemory(dir), model: models[0], tools: [] });
  assert.deepEqual(result.extensionsResult.errors, []);
  await result.session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
  const command = result.session.extensionRunner.getCommand("multi-account");
  assert.ok(command?.getArgumentCompletions, "multi-account completion is registered");
  return command.getArgumentCompletions!;
}

/** Counts every read of the credential files made while `run` executes. */
async function countCredentialReads<T>(run: () => Promise<T>): Promise<{ result: T; authReads: number; sidecarReads: number }> {
  const real = fs.readFileSync;
  const counts = { authReads: 0, sidecarReads: 0 };
  fs.readFileSync = function (this: unknown, path: any, ...rest: any[]) {
    const name = String(path).split(/[\\/]/).pop();
    if (name === "auth.json") counts.authReads++;
    else if (name === "pi-multi-account-proxy-oauth.json") counts.sidecarReads++;
    return (real as any).call(this, path, ...rest);
  } as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    return { result: await run(), ...counts };
  } finally {
    fs.readFileSync = real;
    syncBuiltinESMExports();
  }
}

test("one keystroke of /multi-account use reads the credential files once, not once per account", async () => {
  const { auth, usage } = fixtureAccounts();
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  writeFileSync(join(dir, "provider-failover-state.json"), JSON.stringify({ stateVersion: 5, usageByProvider: usage }));
  writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
    includeCursor: false, childProxy: false, autoDiscoverModels: false, showUsage: true, usageStatusRefreshMs: 3_600_000,
  }));
  const complete = await openCommand();

  const { result, authReads, sidecarReads } = await countCredentialReads(() => Promise.resolve(complete("use ")));

  assert.equal(result?.length, ACCOUNTS, "every account is listed");
  assert.equal(authReads, 1, "auth.json is read once for the whole listing");
  assert.equal(sidecarReads, 1, "the proxy sidecar is read once for the whole listing");
});

test("a rotated credential drops only its own usage snapshot from the listing", async () => {
  const { auth, usage } = fixtureAccounts();
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  writeFileSync(join(dir, "provider-failover-state.json"), JSON.stringify({ stateVersion: 5, usageByProvider: usage }));
  writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
    includeCursor: false, childProxy: false, autoDiscoverModels: false, showUsage: true, usageStatusRefreshMs: 3_600_000,
  }));
  const complete = await openCommand();
  const before = (await complete("use ")) as Array<{ label: string; description: string }>;
  assert.ok(before.find((item) => item.label === "openai-codex-3")?.description.includes("user2@example.invalid"));

  // Re-login of slot 3 with a different token: its snapshot must no longer be trusted.
  auth["openai-codex-3"].access = fakeToken();
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  const after = (await complete("use ")) as Array<{ label: string; description: string }>;

  assert.ok(!after.find((item) => item.label === "openai-codex-3")?.description.includes("user2@example.invalid"),
    "the rotated account loses its stale usage");
  assert.ok(after.find((item) => item.label === "openai-codex")?.description.includes("user0@example.invalid"),
    "untouched accounts keep their usage");
  assert.ok(after.find((item) => item.label === "openai-codex-5")?.description.includes("user4@example.invalid"));
});
