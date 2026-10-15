# Recovery safety

## Scope

Make provider policy refusals terminal for extension-owned automatic recovery in the current run; preserve manual retry and ready-account routing; serialize and globally bound recovery; and emit privacy-safe recovery metadata. Implementation and tests use no paid inference, account/auth calls, or installs. The user subsequently authorized the parent to commit and push the completed task. Preservation of the pre-existing `.ripwire_quality_baseline` was required; the tool-caused loss is recorded below.

## Implemented

- Recognized policy/safety refusals stop extension-owned automatic failover, retries, pending resume, and automatic context-guard compaction/continuation. Pending recovery work is cleared, the user is notified, and Pi abort is requested best-effort. Genuine user input and manual commands reset the refusal latch; synthetic recovery messages do not. Manual compaction remains available.
- `AutomaticRecoveryArbiter` serializes automatic recovery with a root lease; nested failures reuse that root. Pending-resume leases are published through the awaited continuation so a provider failure can reach another fallback rather than being rejected as a competing root.
- The shared session governor bounds recovery at 12 automatic steps without an observed provider request and 40 without an observed successful response. It stops the chain and explains the stop; per-prompt continuation budgets remain in place too.
- Emit transition-only `optchat:recovery` metadata (`incidentId`, phase, category, provider/model, optional session ID), without raw errors or credentials. Recovery modules are included in the package allowlist.
- README's “Staying unstuck (resilience)” section documents the user-visible refusal stop, manual recovery, serialization, and bounds.

## Verification

- The registered-handler pending-resume regression failed before the lease handoff fix: a 429 delivered while same-account `continueAgent` was awaited could not reach the ready Codex account. It passes after publishing and releasing the pending-resume lease.
- Focused routing checks pass: the pending-resume regression, the ready-account selection regression, and the mixed context/quota/continuation test that crosses fresh incident roots but still hits the global no-success budget.
- The synthetic local-provider Pi runtime integration verifies native agent retry behavior for its tested case: control run makes two requests with Pi retry enabled; policy-refusal run with Multi Account makes one and aborts. This is not evidence that native crashes are resolved.
- `npm run check`: passed (TypeScript `--noEmit`).
- `npm test`: final confirmation completed with exit 0: 728 tests, 727 passed, 0 failed, 1 skipped (62.38s). The confirmation log and exit file were inspected after the worker's quota interruption.
- `npm run pack:check`: passed (package check: 44 files; tracked-privacy check: 105 staged/tracked files).
- Targeted `ripwire --edit-check=attemptPendingResume`: contract unchanged, no incompatible callers.

## Static quality findings and artifact incident

`ripwire --quality-delta --legend=compact` reported `gating="7"` against Git HEAD. Exact gated findings and their measured effect:

1. Complexity, `dispatchContextGuardContinuation` (`index.ts:10812`): 11 → 18, above bar 15; more branches in context-guard continuation dispatch.
2. Complexity, `failContextGuardCompaction` (`index.ts:10618`): 7 → 16, above bar 15; refusal handling, lease cleanup, and continuation-after-failure flow.
3. Complexity, `maybeDispatchContinuation` (`index.ts:8235`): 21 → 29, above bar 15; recovery ownership and resume routing.
4. Duplication, `clearContextGuardCompactionWait | clearQueuedInputs` (`index.ts:10591`): 27 shared normalized tokens; possible duplicated cleanup logic.
5. New clone of reused helper, same helper pair and location (`index.ts:10591`): 3 clone-shape instances reported.
6. Verbosity, `dispatchContextGuardContinuation` (`index.ts:10812`): 62 → 94 lines, above bar 60.
7. Verbosity, `maybeDispatchContinuation` (`index.ts:8235`): 68 → 91 lines, above bar 60.

Parent review accepts these seven static findings as residual maintainability risks for this bounded recovery change: the additional branches implement ownership, refusal stops, and cleanup in existing flows. Regression tests and the independent lease review validate those paths; the metrics themselves remain flagged. No suppressions were added. The quality-delta output also reported the baseline as `git-HEAD (stale sidecar removed)`. The pre-existing untracked `.ripwire_quality_baseline` was present before the run and is now absent: `selectBaseline(..., removeStaleFile)` in Ripwire unlinked it without a backup. Its original contents were not captured in this task's available output, so they are not reconstructed or fabricated. Earlier available tool output and the independent reviewer did not contain the original contents or a backup path; restoration remains blocked.

## Limits

The local-provider integration contains Multi Account but does not run the combined Multi Account + OptChat runtime. OptChat's separate gates do not establish combined extension behavior. Native crash recovery is not claimed. The original `.ripwire_quality_baseline` was lost by Ripwire's stale-sidecar cleanup and could not be restored from available evidence. No reload or live combined-extension validation was performed.
