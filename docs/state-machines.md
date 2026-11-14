# Implicit state machines

Catalog of the lifecycles in this package that are encoded as flags, timers, counters or persisted
JSON rather than as one explicit state. Line numbers refer to the tree at the commit that added
this file. Severity: **P1** data loss or runaway loop, **P2** wrong behaviour reachable in normal
use, **P3** latent, cosmetic or only reachable through hand-edited state.

Out of scope: `cursor/proto/agent_pb.ts` (generated).

`index.ts` is one closure of ~13k lines; almost every machine below is a handful of `let`
variables inside `piMultiAccount()`. The coordination idiom that keeps them honest is `chainEpoch`:
every async chain captures the epoch it started under and abandons itself when it changes.

Legend for "fixed": the fix and its regression test are in the same change; "catalogued" means the
finding is recorded here and deliberately not changed.

## Summary

| # | Machine | States | Explicitness before → after | Findings |
|---|---------|--------|-----------------------------|----------|
| 1 | Cursor loopback proxy listener (`cursor/proxy.ts`) | stopped / starting / listening | 2 nullable fields → `proxyStarting` + stop epoch | F1 P2 fixed, F2 P2 fixed |
| 2 | Cursor SSE stream writer (`writeSSEStream`) | streaming / tools_queued / tools_paused / finished / cancelled | 4 booleans → `StreamPhase` table | F3 P3 fixed |
| 3 | Cursor bridge process handle | alive / ended / exited | 2 booleans, private, correct | none (explicit enough) |
| 4 | Cursor upstream watchdog | armed / stopped | closure flag, correct | none |
| 5 | Cursor conversation registry | stored / stale / forgotten (+ generation) | map + counter, correct | none |
| 6 | Context-guard compaction | idle / wanting / in flight / backoff | 6 variables → + request sequence | F4 P2 fixed |
| 7 | Resume watchdog (stuck turn) | idle / watching / aborting | 5 variables | F5 P2 fixed |
| 8 | Pending resume + wake timer | none / armed / parked | nullable object + persisted marker + timer + backoff | F6 P3 |
| 9 | Account availability (cooldown / invalid / untrusted) | ready / cooling / invalidated | 5 maps + persisted file | F7 P3 |
| 10 | Governor (loop bound) | dormant / armed / stopped | 7 variables | none |
| 11 | Recovery arbiter (`recovery-safety.ts`) | idle / active / stopped | explicit class, lease tokens | none |
| 12 | Failover warm-up route | none / warm-up active / upgrading | 3 nullable fields | F8 P3 |
| 13 | Manual / failover one-attempt pins | none / granted / covered | 2 fields each | none |
| 14 | Session role | root / passive child / superseded / closed | 4 booleans | F9 P3 |
| 15 | Shared slot-proxy coordinator | no server / starting / canonical / foreign | 12 fields across closure + coordinator | F10 P3 |
| 16 | Usage polling | idle / fetching / cached | map of promises + interval | none |
| 17 | OAuth forced refresh | idle / in flight → refreshed / terminal / transient / unsupported | single-flight map, explicit result union | none |
| 18 | Held-input queue (`queuedUserInputs`) | empty (never populated) | dead machine | F11 P3 |
| 19 | Persisted failover state file | versioned JSON | `as ProviderFailoverState`, no field validation | F12 P3 |
| 20 | Cursor module loader (`cursor-bridge.ts`) | unloaded / loading / loaded / failed(+retry) | single-flight promise, correct | none |

## 1. Cursor loopback proxy listener

`cursor/proxy.ts` — `proxyServer`, `proxyPort`, `proxyStarting`, `proxyStopEpoch`, `startProxy`,
`stopProxy`; shared memo in `cursor/cursor-shared.ts` `ensureCursorProxy`.

- **States:** stopped (`proxyServer` unset) · starting (`proxyStarting` set) · listening
  (`proxyServer` + `proxyPort`).
- **Events:** `startProxy()`, listen callback, listen `error`, `stopProxy()`.
- **Transitions:** stopped → starting → listening; listening → stopped (`stopProxy`); starting →
  stopped (`stopProxy` bumps `proxyStopEpoch`, the bind callback sees the stale epoch and closes its
  socket); starting → stopped on bind error (promise rejects).
- **Lives in:** process memory, module scope. **Readers:** `getProxyPort`, every Cursor slot via
  `ensureCursorProxy`, `cursor/index.ts`.
- **Invariant:** at most one listener per process; a stopped proxy never reappears.

Findings (before):

- **F1 P2 — concurrent start double-binds.** `startProxy` tested `proxyServer && proxyPort`, which
  are only assigned inside the `listen` callback, so two callers inside the bind window each created
  a server. The second overwrote `proxyServer`; the first stayed bound and could never be closed by
  `stopProxy`. `cursor/index.ts:474` and `ensureCursorProxy` can both run in one process.
  **Fixed** (single in-flight promise). Test: `test/cursor-proxy-lifecycle.test.ts` "concurrent
  startProxy calls share one listener".
- **F1b P2 — stop during start published the socket anyway** (`proxyServer` assigned after
  `stopProxy` had run), and a listen `error` was logged but never settled the promise, so every
  waiter (and Pi's session start behind it) hung. **Fixed** (stop epoch; error rejects). Test:
  "stopProxy during a start releases the socket".
- **F2 P2 — failed start remembered.** `ensureCursorProxy` did `proxyPromise ??= startProxy(...)`, so
  a rejection was cached for the life of the process. **Fixed** (memo cleared on rejection). Test:
  "a failed shared proxy start is not remembered".

## 2. Cursor SSE stream writer

`cursor/proxy.ts` `writeSSEStream`; table in `cursor/stream-phase.ts`.

- **Before:** `closed`, `cancelled`, `mcpExecReceived`, `toolCallsFlushed` plus a coalesce timer.
  Handlers combined them by hand (`closed || cancelled || toolCallsFlushed`, `closed ||
  mcpExecReceived`).
- **After:** `phase: StreamPhase` with a transition table; `closed` stays as the separate I/O fact
  "`res.end()` was called" because an error chunk is still written between `cancelled` and `end`.

```
streaming ──tool exec──▶ tools_queued ──coalesce window──▶ tools_paused
    │                         │
    ├─ turnEnded / stream error ─▶ finished ◀─ bridge closed before tools could run
    └─ client gone / stall ──────▶ cancelled ◀─ client gone / stall
```

`tools_paused`, `finished`, `cancelled` are terminal for the writer; a paused Run is continued by a
new writer (`handleToolResultResume`) that replaces the bridge callbacks. Illegal moves throw
under `node --test` (`NODE_TEST_CONTEXT`) and are logged once then ignored otherwise.

- **F3 P3 — dead bridge left registered while paused.** The `code !== 0` "Bridge connection lost"
  branch in the bridge-close handler could never run (`closed` is already true after the flush), and
  the paused run's `activeBridges` entry was never removed when its bridge died, so the next request
  found a dead handle and had to clean it up. **Fixed:** the paused phase drops its own entry.
  Test: `test/cursor-stream-phase.test.ts` "a bridge that dies while the stream is paused…".
- Catalogued: the non-streaming path (`handleNonStreamingResponse`) uses `cancelled` + `settled`
  with a single `settle()` guard; two flags, one transition point, correct.

## 3–5. Cursor bridge handle, upstream watchdog, conversation registry

Explicit and correct; no change.

- `cursor/bridge-handle.ts` `createBridgeHandle` — `exited`/`ended` collapse into the public `alive`;
  writes after end are dropped; every stream carries an error listener. `onClose` registered after
  exit fires on a microtask, so a late registration is not lost. Only gap: a process that fails to
  spawn emits `error` but never `exit`, so `onClose` waits for the stall watchdog (P3, bounded by
  the 60 s transport watchdog, catalogued).
- `cursor/upstream-watchdog.ts` `startUpstreamWatchdog` — `stopped` is set before `onStall`, so the
  callback runs at most once; `touch` after stop is inert; early timer wakes re-arm from a monotonic
  deadline.
- `cursor/conversation-registry.ts` — `conversationStates` + generation counter; a stale checkpoint
  (`isStaleForTranscript`) is discarded rather than resumed.

## 6. Context-guard compaction

`index.ts:10712` (`contextGuard*`), `armContextGuardCompactionWatchdog`,
`failContextGuardCompaction`, `dispatchContextGuardContinuation`, `agent_settled` handler.

- **States (derived):** idle · wanting (`WantsCompaction`) · in flight (`CompactionInFlight` +
  watchdog timer + recovery lease + `ContinuationPending`) · backoff (`CompactionRetryAfter`).
- **Events:** over-threshold observation, `agent_settled`, `ctx.compact` `onComplete`/`onError`,
  `session_compact`, `session_compact_failed`, watchdog timeout, user control.
- **Lives in:** closure variables; `ContinuationPending` is also the marker that a resume owes the
  user a "carry on".
- **F4 P2 — a written-off request could settle its successor.** The in-flight flag is one global
  boolean, but the `ctx.compact` callbacks belong to one request. After the watchdog or
  `session_compact_failed` wrote request #1 off and #2 started (≥120 s later), a late `onComplete`
  from #1 cleared #2's in-flight flag and dispatched #2's continuation ("carry on") while #2 was still
  summarising, and the next `agent_settled` started a third compaction. **Fixed:** each request
  carries `contextGuardRequestSeq`; callbacks from a superseded request are ignored and logged
  (`context_guard_stale_callback`). Test: `test/failover.test.ts` "a summarizer answering after its
  request was written off cannot settle the next compaction".

## 7. Resume watchdog

`index.ts:4431` `activeResumeWatch`, `progressWatchdogTimer`, `watchdogAborting`, `toolInFlight`,
`stuckReminders`, `lastResumeProgressAt`, `watchdogCtx`; `beginResumeWatch`, `endResumeWatch`,
`onResumeStuck`.

- **States:** idle · watching · aborting (we called `ctx.abort()` and expect `agent_end(aborted)`).
- **Events:** continuation dispatched, any progress event, tool start/end, timer tick, `agent_end`,
  user control, shutdown.
- **F5 P2 — unanswered watchdog abort.** `watchdogAborting` is how `agent_end` tells our abort from
  a user Esc, but nothing cleared it if the host never answered the abort, and the stuck timer was
  not re-armed after the abort. The flag then survived a new prompt (`claimUserControl` does not
  reset it) and the user's next Esc was read as "our recovery": a same-provider retry was armed for
  work the user had just cancelled. **Fixed:** after the abort a verification tick runs
  (`ABORT_REPORT_GRACE_WINDOWS` × `stuckWatchdogMs`); if the flag is still set it is written off
  (`resume_abort_unanswered`) and the bounded reminder path takes over without aborting again.
  Test: `test/failover.test.ts` "a watchdog abort the host never reports does not turn a later user
  Esc into a recovery".
- Catalogued (P3): `watchdogAborting` appears at 14 sites; a union
  `idle | watching | aborting` would remove the remaining ad-hoc resets. Not done: it crosses
  `stopEverything`, both command handlers and `agent_end`, and the fix above closes the bug.

## 8. Pending resume and wake timers

`index.ts:4340` `pendingResume`, `pendingWakeTimer`, `pendingWakeBackoffMs`, `pendingResumeHops`,
`chainEpoch`, `userAbortedChain`; persisted `pendingFrom/Reason/Since/Owner/ContinuationPrompt`;
`setPendingContinuation`, `schedulePendingWake`, `attemptPendingResume`, `parkPendingResume`,
`clearPendingContinuation`, `claimUserControl`.

- **States:** none · armed (timer set) · parked (armed with `notBeforeMs`) · resuming.
- **Invariants:** at most one timer (`schedulePendingWake` clears first); a wake abandons itself if
  `chainEpoch` moved; the persisted marker is session-owned (`pendingOwner`) and a session start
  clears a leftover one.
- **F6 P3:** the in-memory object and the persisted marker are two writers of one fact. They are
  reconciled in `persist()` (owner-aware merge) and covered by `test/session-ownership.test.ts`; an
  external edit of the state file can still make `status` report pending work that has no timer.
  Catalogued.

## 9. Account availability

`index.ts:4127-4184`: `exhaustedUntilByProvider`, `exhaustedUntilByModel`, `invalidatedByProvider`,
`usageUntrustedUntilByProvider`, `authFailures`, `limitStreakByProvider`, `usageByProvider`,
`responseCooldownHints`; `providerRecoveryAt` derives readiness; `markExhausted`, `markInvalid`,
`noteAuthSuccess`, `markAuthFailure`, `pruneCooldowns`, `clearReauthedInvalidations`.

- **States (derived, never stored):** ready · cooling until T · invalidated (until credential hash
  changes) · usage-untrusted (meter ignored until T).
- **Transitions:** limit error → cooling; second limit error in window → untrusted; success → ready
  (clears all five); 401 on a rotated token ×N → invalidated; credential hash change → ready.
- **Readers:** selection (`findFallbackModels`), wake delay, status, usage reconciliation.
- **Invariants:** a cooldown never exceeds `MAX_LIVE_COOLDOWN_MS` (clamped on load and in
  `pruneCooldowns`); invalidation is not a cooldown; a fresh `serviceable` verdict outranks derived
  numbers.
- **F7 P3:** availability is correct but spread over five maps with no single transition function;
  every writer must remember to persist. Mitigated by `noteAuthSuccess` being the single reset and
  by extensive tests. Catalogued, not refactored.

## 10. Governor

`index.ts:4389` `actionsSinceRequest`, `actionsSinceSuccess`, `firstActionSinceRequestAt`,
`governorStoppedReason`, `requestSignalSeen`, `successSignalSeen`; `allowAction`, `stopEverything`,
`resetGovernor`.

- **States:** dormant (signals unseen) · armed · stopped. Explicit table in comments; one stop
  function (`stopEverything`) clears every timer. Already the repo's model of a bounded machine;
  catalogued only.

## 11. Recovery arbiter

`recovery-safety.ts` `AutomaticRecoveryArbiter` — single active lease, owner tokens, `release()` is
idempotent and only the owning lease ends the incident, `stopForPolicyRefusal` is sticky until
`resetForUserControl`. Explicit and correct.

## 12. Failover warm-up route

`index.ts:4415-4420` `automaticModelTarget`, `automaticWarmupTarget`, `pendingWarmupUpgrade`;
`activateFallback`, `startFailoverWarmup`, `finishFailoverWarmup`, `model_select` handler.

- **States:** none · warm-up active (model switched to the cheap model, upgrade pending) · upgrading
  (setModel to the chosen target in flight).
- **F8 P3:** `agent_start` clears `automaticModelTarget` but not `automaticWarmupTarget`. If a host
  never emits `model_select` for the warm-up switch, a later manual selection of that same model is
  swallowed as automatic. Not observed on supported hosts; catalogued.

## 13. One-attempt pins

`index.ts:4197-4262` `manualPinnedProvider`/`manualPinCoveredMessage` and
`failoverPinnedProvider`/`failoverPinCoveredMessage`. Two fields each, one grant function and one
retire function per pin, retired on the next genuine `input`. Explicit enough; catalogued.

## 14. Session role

`index.ts:3940-4011` `subagentChild`, `supersededRoot`, `sessionClosed`, `hostOwnsSessionModel`,
`activations[activationKey]`, `chainEpoch`.

- **States (derived):** root · passive child · superseded root · closed. `relinquishRoot` sets three
  flags at once; `session_shutdown` sets one; `session_start` resets `sessionClosed` (12253) and may
  demote to child (12264), so the role is not monotonic.
- **F9 P3:** four booleans for one role, read in ~30 places. A role union would touch most of the
  file; the writers are `relinquishRoot`, `session_start`, `session_shutdown` and the env check, and
  the illegal combinations (e.g. `supersededRoot` without `sessionClosed`) are not produced by any of
  them. Catalogued.

## 15. Shared slot-proxy coordinator

`index.ts:11379-11880` `slotProxyServer`, `slotProxyPort`, `slotProxyStarting`,
`slotProxyForeignOwner`, `slotProxyCoordinator` (`members`, `routes`, `publisher`, `handlerOwner`,
`server`, `starting`), `member.ready`; `startSlotProxy`, `stopSlotProxy`, `joinSharedProxy`,
`activateSharedProxy`, `publishProxiedSlots`.

- **States:** no listener · starting · canonical owner · foreign owner (ephemeral port, not the
  publisher) · handed off (no ready member → 503).
- **Invariants (AGENTS.md):** shared publication yields on Windows lock retries, checks session
  validity and publisher ownership, and drains before shutdown route cleanup; the canonical port is
  held until shared files are restored. Exercised by `test/slot-proxy*.test.ts` and the
  `failover.test.ts` shutdown-ordering tests.
- **F10 P3:** `slotProxyStarting` (closure) and `coordinator.starting` are two copies of one promise,
  and `startSlotProxy` re-enters itself after a foreign owner forces a local port. Correct under the
  existing tests; not changed because the ordering contract is load-bearing.

## 16. Usage polling

`index.ts:4144` `usageFetches`, `usageErrors`, `usageStatusTimer`; `refreshUsage`,
`fetchFreshUsage`, `storeUsage`, `startUsageStatusTimer`, `usage.ts` fetchers (per-call
`AbortController` + timeout cleared in `finally`).

- Single-flight per provider, TTL cache, snapshot accepted only if the credential hash still matches
  (`usageSnapshotIsCurrent`) and the session is open, timer `unref`'d and cleared on shutdown and
  `relinquishRoot`. Explicit and correct.

## 17. OAuth forced refresh

`index.ts:4873` `forcedRefreshes` single-flight map, result union `refreshed | terminal | transient
| unsupported`; persistence through `refreshAndPersistWithStorageLock`; a refresh that cannot be
written is `terminal`, never `transient`. Explicit and correct.

## 18. Held-input queue

`index.ts:4405` `queuedUserInputs`, `queuedInputWakeTimer`, `queuedWakeBackoffMs`,
`scheduleQueuedInputWake`, `attemptQueuedInputResume`.

- **F11 P3 — dead machine.** Nothing pushes to `queuedUserInputs` any more (the `input` handler
  deliberately lets the message stay in Pi's transcript). Every reader sees an empty array, so the
  timer, backoff and flush loop are unreachable. Had it been live, two concurrent
  `attemptQueuedInputResume` runs (timer wake and manual selection) would both send `queue[0]`.
  Catalogued; removal is a separate cleanup.

## 19. Persisted failover state

`index.ts:2020` `loadState`, `persist` (`index.ts:4695`), `state-file-transaction.ts`.

- Versioned (`stateVersion`), migrated, read-latest/merge under a lock. Field types are trusted:
  `JSON.parse(...) as ProviderFailoverState`.
- One fact may be newer in memory than on disk: a usage reading from response headers that repeats
  the previous one (`usageTelemetryUnsaved`). Any `persist()` writes it; `flushUsageTelemetry` does
  so at `agent_end`, on the status tick and at `session_shutdown`. Every other change is written
  when it happens.
- **F12 P3:** a hand-edited or foreign file with `lastSwitches: 5` throws inside `activateFallback`
  after the model switch succeeded; non-finite or string cooldown values are accepted. The extension
  is the only writer and `loadState` falls back to an empty state on parse errors, so this is
  catalogued rather than guarded.

## 20. Cursor module loader

`cursor-bridge.ts` `sharedModPromise`, `loadAttempt` — caches the in-flight import promise, clears it
and bumps a cache-busting query on failure so a later attempt re-imports. Explicit and correct.

## Not machines

`model-catalog.ts`, `model-pins.ts`, `command-*.ts`, `completion-route-planner.ts`,
`provider-priority.ts`, `child-usability.ts`, `pi-contract.ts`, `slot-proxy-auth.ts`, `usage.ts`
parsers: pure functions or data tables without lifecycle state.
