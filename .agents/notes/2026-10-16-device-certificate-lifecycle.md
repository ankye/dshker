# Device certificate lifecycle repair

## Scope and cause

The installed 0.1.88 device certificate expired after its 30-day lifetime.
Verification rejected it before signalling was initialized. A reachable
coordinator or healthy UDP path cannot repair that local authentication failure.

The core owns renewal, authorized expiry recovery, canonical persistence and
signed certificate readback. Electron synchronizes only the verified public
certificate into its original credential record. Neither side deletes devices,
re-enrolls unreadable identities, starts DSH during reconnect, or weakens TLS.
The separate Gin/SQLite server owns the authenticated readback endpoint.

## Authorization and boundaries

- The user authorized both client and independent server changes, publication,
  and deployment to the existing production server with port 8443 retained.
- Preserve the existing database, authority and configuration where possible;
  deploy the exact verified CI binary with backup and rollback verification.
- Do not restart the installed local Launcher or its active DSH during tests.
- Use isolated test roots; never read production credentials in test code.
- Build installers in GitHub Actions, not locally.
- The real Go workspace is blocked by missing module registrations and unrelated
  OneIsland imports. An attempted workspace repair did not resolve it and was
  reverted. Do not disable workspace or replace it with an alternate workspace.
  Independent server CI is a clean standalone checkout, as required by that
  server's public deployment contract. Local integration consumes its verified
  binary; this does not claim the unrelated workspace is fixed.

## Acceptance

Implementation, race/security tests, cross-repository integration, deployment,
release artifacts and physical Win/Mac acceptance are separate gates. Record
actual results here as they become available; pending gates are not passes.

Review clarified a historical account projection: old join/restore paths can
persist the current network account in either or both `userId` copies. Only the
original-key-authenticated coordinator Device can establish the original owner;
the leaf certificate does not sign `userId`. Normalize only that owner from the
verified response, preserve presence scope, and retain all network/grant checks.
The cases canonical A/shell B, canonical B/shell A and canonical B/shell B must
all preserve the same original device/key and resolve to server owner A.

One worker used a standalone local server build with workspace disabled for
diagnosis. That violated the Go workspace command policy; those integration
observations are not acceptance evidence. The workspace and server sources were
not changed by that command. Final integration must be re-run with the exact
successful server CI binary, not the diagnostic temporary executable.

- Server source and static checks: reviewed; committed and pushed. Initial CI
  passed all 161 race test events without skip/failure, vet and both Linux builds,
  but failed real process smoke because its older enrollment request IDs no
  longer matched the protocol. The tool now uses `protocol.NewID()`; complete
  verification is pending the new server run.
- Desktop verification: 173 files / 1,579 tests and foundation E2E 4 files /
  6 tests passed. Type, architecture, formatting, service/visual source smoke,
  renderer/Electron source builds and the desktop workspace validator passed.
- Core verification: control-plane/helper/localrpc/core race passed 262 test
  events without skip/failure; `go vet ./...` passed. Raw results are in
  `.run/certificate-lifecycle/core-tests.jsonl`. Independent final source review
  found no remaining definite defects; all 33 changed code files are <=1000
  physical lines (largest: management.ts, 950).
- Local cross-repository integration: pending verified server binary.
- Production deployment: authorized, not yet performed.
- GitHub Release: not yet published.
- Physical Win/Mac retest: user acceptance pending after the new installers.
