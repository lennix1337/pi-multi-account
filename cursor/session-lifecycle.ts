import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SessionContext = { sessionManager: { getSessionId(): string; getLeafId?: () => string } };

export function registerSessionLifecycleHooks(
  pi: ExtensionAPI,
  dependencies: {
    cleanupSessionState: (sessionId: string) => void;
    /** Start a new Cursor-side conversation, keeping the session alive. */
    resetConversationForSession?: (sessionId: string) => void;
    debug?: (event: string, data: Record<string, unknown>) => void;
    /** A reload loads a fresh copy of the extension that binds its own proxy; the old one would stay bound, holding the old runtime. */
    stopProxy?: () => void;
    /** Forget this session's runner; true when no other session of this extension instance still uses the proxy. */
    releaseSession?: () => boolean;
  },
): void {
  const cleanupCurrentSession = (_event: unknown, ctx: SessionContext) => {
    dependencies.debug?.("session.cleanup_hook", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
    });
    dependencies.cleanupSessionState(ctx.sessionManager.getSessionId());
  };

  pi.on("session_before_switch", cleanupCurrentSession as any);
  pi.on("session_before_fork", cleanupCurrentSession as any);
  pi.on("session_before_tree", cleanupCurrentSession as any);
  // Compaction is the one event that changes what the conversation IS without ending it.
  // Cursor never sees Pi's compacted message list while it holds a checkpoint, so unless the
  // conversation is restarted here, the model keeps the full pre-compaction context and keeps
  // reporting its size — which sends Pi straight into compacting again on the next turn.
  pi.on("session_compact", ((_event: unknown, ctx: SessionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    dependencies.debug?.("session.compact_hook", {
      sessionId,
      leafId: ctx.sessionManager.getLeafId?.(),
    });
    dependencies.resetConversationForSession?.(sessionId);
  }) as any);
  pi.on("session_shutdown", ((event: unknown, ctx: SessionContext) => {
    cleanupCurrentSession(event, ctx);
    const reason = (event as { reason?: string } | undefined)?.reason;
    const last = dependencies.releaseSession?.() ?? true;
    // `quit` also ends embedded sessions (subagents, OptChat workers) while the process lives on;
    // the last one out closes the listener, which would otherwise keep their runtimes in memory.
    if (reason === "reload" || (reason === "quit" && last)) dependencies.stopProxy?.();
  }) as any);
}
