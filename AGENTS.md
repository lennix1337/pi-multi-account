# Working on pi-multi-account

Pi extension for account discovery, quota-aware routing, and bounded recovery. Read `README.md` for user-visible behavior and `CONTRIBUTING.md` for development/release procedures. This checkout is the lennix1337 fork; package metadata may refer to upstream. Pushing the fork is not an npm release.

## Change boundaries

- `index.ts` orchestrates Pi lifecycle and routing. Focused modules handle config/auth transactions, atomic replacement, recovery safety, catalogs, usage, and Cursor integration. Follow the existing module boundary rather than adding more unrelated orchestration.
- Preserve selected-route retry versus quota-failover semantics, thinking-level retention, and explicit stop/policy-refusal behavior. Test state transitions using `test/failover.test.ts` and the focused recovery tests.
- Use field-scoped, locked read-latest config transactions; preserve unrelated settings, model overrides, and symlinks. Shared model publication must yield during Windows lock retries, check session validity and publisher ownership, and drain before shutdown route cleanup.
- Keep child-local routing separate from canonical shared publication. Test cancellation, rediscovery, concurrent writes, and shutdown ordering when changing publication contracts; await asynchronous provisioning callbacks.
- Keep credentials out of logs, fixtures, rotation state, and commits. Use disposable config directories and fake providers in tests. Real account switching, OAuth refresh, provider calls, and paid inference require explicit task scope.

## Verification

- Inspect `package.json` for supported host versions and authoritative scripts. Run `npm run check`, focused tests for the changed behavior, then `npm test` for lifecycle/routing changes. Run `npm run pack:check` for changes to packaged files or dependencies.
- Windows file-lock behavior needs native Windows coverage; Linux passing does not prove reader-contention handling. Keep atomic replacement and session-cancellation regression tests intact.
- Update `CHANGELOG.md` under Unreleased and the README for user-visible behavior. Report measured publication latency separately from whole-startup latency, and disclose failed static gates.
- Review the final diff and privacy checks before an authorized push. Follow the tag-guarded workflow in `CONTRIBUTING.md` only when a release is explicitly requested; preserve upstream attribution and package ownership.
