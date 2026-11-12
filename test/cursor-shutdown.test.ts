import assert from "node:assert/strict";
import test from "node:test";
import { registerSessionLifecycleHooks } from "../cursor/session-lifecycle.ts";

test("session shutdown cleans only the session; a later session reuses the process proxy", () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const cleaned: string[] = [];
  const pi = { on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } as any;
  const ctx = { sessionManager: { getSessionId: () => "test-session", getLeafId: () => "leaf" } };

  registerSessionLifecycleHooks(pi, {
    cleanupSessionState: (sessionId) => cleaned.push(sessionId),
  });
  handlers.get("session_shutdown")?.({}, ctx);

  assert.deepEqual(cleaned, ["test-session"]);
});

test("a reload stops the process proxy, because the next extension instance starts its own", () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const stopped: string[] = [];
  const pi = { on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } as any;
  const ctx = { sessionManager: { getSessionId: () => "test-session", getLeafId: () => "leaf" } };

  registerSessionLifecycleHooks(pi, { cleanupSessionState: () => {}, stopProxy: () => stopped.push("stop") });
  handlers.get("session_shutdown")?.({ reason: "new" }, ctx);
  assert.deepEqual(stopped, [], "/new keeps the proxy: the same extension instance goes on serving");
  handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  assert.deepEqual(stopped, ["stop"], "a reload leaves the old listener bound, holding the old runtime and its memory");
});
