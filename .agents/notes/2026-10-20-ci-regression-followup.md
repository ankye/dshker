# P2P release CI follow-up

- App Quality run `39371808773` failed in `Verify peer connection` during the
  Linux real-process certificate suite. The legacy CLI process fixture had not
  enabled its exact coordinator service in the catalog, so login correctly
  failed with `p2p.not_enabled` / `p2p.service_unconfigured`. The fixture now
  enables that service explicitly; no production fallback was added.
- The same run reached the existing source request budget during the
  `RestoreOwnCredentials` maintenance assertion and returned
  `p2p.rate_limited`. The test now uses the existing `waitForRequestBudget`
  helper before that independent assertion; production request limits and
  recovery deadlines are unchanged.
- `test-gates/open-workbench-recovery.json` now declares the Linux-only real
  coordinator/CLI test file. These test-only edits are pending fresh CI proof.
- Server CI `39371618100` passed 77 coordinator tests, then Go's implicit
  10-minute package timeout fired while the full race suite was still running;
  no assertion failure preceded the timeout. The server candidate-handoff
  manifest now sets an explicit 15-minute Go test deadline and the Linux CI job
  allows 20 minutes. This changes only test-suite capacity, not a product
  timeout or recovery budget. Rerun pending.
- Package run `39371808799` passed all native targets for the preceding app
  source SHA, not the uncommitted test fixes. No matching CI, server deployment,
  8-hour physical acceptance, or release is claimed here.
