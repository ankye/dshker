# Legacy certificate recovery scope

## Incident and authorization

The user confirmed 0.1.89 can sign in but cannot join the network. Read-only
diagnostics show `p2p.certificate_recovery_required`, expired original device
certificates and an empty recovery metadata network. The account already has a
persisted manual network selection; server device bindings and the original
pair remain active. This is a client legacy-scope migration gap, not evidence
that a password reset removed the network.

The user authorized the repair, preservation of existing devices/networks/pairs,
tests, commit/push, an exact stable tag and a formal GitHub Release. This follows
OpenSpec `repair-device-certificate-lifecycle`, D6 and tasks 4.1–4.4. No local
installer packaging, production credential edits, account recreation, server
deployment or installed DSH restart is part of this repair.

## Contract

- First ask the existing certificate owner to maintain the original credential.
- Only the exact recovery-required refusal, an absent legacy `networkId` and
  a current authenticated session enter manual-selection migration.
- Resolve selection for the current account, freshly verify the exact owned
  network and membership of the original device, and recheck token, selection
  and lifecycle before one scoped request.
- Missing, deleted, foreign, unbound or changed scope is an explicit refusal;
  do not choose a unique/first network or overwrite nonempty core metadata.
- Only the desktop certificate changes. Its legacy shape, original device/key,
  service pin, account projection and network/pair records stay unchanged.
- Manual network selection schedules the same serialized maintenance flow.
- Tests use isolated roots and CI's OS credential provider, never installed
  user keys or active DSH. Independent server CI artifacts remain separate
  from local workspace health and actual cross-machine acceptance.

## Verification and delivery

- Implemented only the three Electron owners: scoped selection admission,
  certificate-session migration and management composition. No production Go
  behavior or independent server deployment changes are needed.
- Source preflight: full Vitest 176 files / 1,624 tests passed without pending
  cases, focused P2P/preload regression 34 files / 515 tests passed, foundation
  E2E 4 files / 6 tests passed. Type, environment, architecture, formatting,
  renderer/Electron source builds, service/visual source smoke and the desktop
  workspace application validator passed. These are not installer or physical
  cross-machine acceptance.
- Go preflight: vet passed, core race passed all 262 test cases without fail or
  skip, and the five real coordinator lifecycle scenarios passed in 13.88
  seconds against the clean Darwin server CI binary at revision a369f8c. Its
  source identity is the same as the deployed coordinator. No local standalone
  server build or alternate workspace was used.
- Added Linux production-CLI/OS-credential tests for missing/empty legacy
  metadata, exact authenticated selection, unauthorized scope, complete
  identity/sidecar readback, grant accounting and coordinator/core restart.
  Linux compilation/vet passed; actual Secret Service execution remains a CI
  gate and has not yet been accepted from compilation alone.
- Source-size gate measured all nine changed code files with no violation
  (largest: management.ts, 957 lines). The dedicated data-critical manifest is
  `test-gates/legacy-certificate-recovery.json`; static validation is authoring
  feedback only. Default verify additionally requires a successful CI for the
  exact client commit and the original Linux evidence ZIP's SHA-256 and source
  binding before parsing real process results.
- Independent final review, exact-revision CI, default verify, native GitHub
  packages and public stable Release checks remain pending. Physical Win/Mac
  acceptance remains a separate post-install user check, not inferred from CI.
