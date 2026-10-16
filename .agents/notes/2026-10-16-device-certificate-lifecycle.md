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
  exposed obsolete enrollment request IDs in the process smoke tool; it now uses
  `protocol.NewID()`. Final run 38890132741 passed the complete race/vet/boundary,
  production-binary isolation, clean source identity and real process smoke
  gates, plus Linux amd64/arm64 and Darwin arm64 builds. Source revision:
  `a369f8c55b6df01ebd3204cf1987fbd054876797`.
- Desktop verification: 173 files / 1,579 tests and foundation E2E 4 files /
  6 tests passed. Type, architecture, formatting, service/visual source smoke,
  renderer/Electron source builds and the desktop workspace validator passed.
- Core verification: control-plane/helper/localrpc/core race passed 262 test
  events without skip/failure; `go vet ./...` passed. Raw results are in
  `.run/certificate-lifecycle/core-tests.jsonl`. Independent final source review
  found no remaining definite defects; all 33 changed code files are <=1000
  physical lines (largest: management.ts, 950).
- Local cross-repository integration: passed all five scenarios with the clean
  Darwin CI binary from server run 38887108067, revision ba933fcc, SHA-256
  `94a1b3cb444fa196dcc0c2bb9041593449b085f423d75331368f18818c5877a4`.
  The race run took 15.883 seconds without skip/failure. Evidence is
  `.run/certificate-lifecycle/local-real-coordinator.jsonl`.
- Linux production composition: client Quality run 38889812619 (79d770fd)
  passed the real CLI/OS Secret Service credential readback and restart test
  (3.22 seconds) plus the full certificate lifecycle test (15.12 seconds), with
  zero skipped/failed events. Artifact `certificate-lifecycle-linux-process`
  is bound to that exact revision; this is not macOS/Windows physical-device
  acceptance.
- Default test-integrity verify passed at client revision 79d770fd with 14 test
  files, 7 commands and 5 evidence bindings. OpenSpec strict validation passed.
- Client main Quality 38889812619 and Package 38889812629 both passed; all six
  desktop and six CLI targets built successfully. Main builds do not publish.
- Production deployment: completed at 2026-10-16 19:04 Asia/Shanghai using the
  verified Linux amd64 CI binary, SHA-256
  `88ee71c50ea8d66b5ffc6d7db2a77d9359535d706a197285b6111e9421c6d0a1`.
  Database hash was unchanged before startup; account/device/network/binding/pair
  counts remained 1/2/2/2/1. Configuration, identity key and service ID were
  unchanged. Trusted external HTTPS, new query-route admission and an external
  STUN binding response on UDP 8443 passed; TCP/UDP listeners belong to the new
  service process. No automatic restart was observed. A private complete backup
  remains at
  `/var/backups/dshker-server/certificate-a369f8c55b6df01ebd3204cf1987fbd054876797.2WhQ8S`.
- GitHub Release: [v0.1.89](https://github.com/ankye/dshker/releases/tag/v0.1.89)
  published at 2026-10-16 11:18:39 UTC, numeric Release ID 414878979,
  `draft=false`, `prerelease=false`. Tag Package run 38891405088 passed all
  14 jobs, including publication and the post-publication installer gate.
  Annotated tag d9f206bc resolves to client commit 79d770fd, matching the run
  and all desktop manifests. All 25 expected public assets are uploaded with
  nonzero sizes and SHA-256 digests; six desktop and six CLI targets are
  present. Independent readback checked source/version, expected asset set and
  CLI manifest/archive digest agreement. A separate root verification confirmed
  the stable latest feed resolves to this Release, all eight desktop and six
  CLI checksum rows match GitHub asset digests, downloaded manifests match their
  own asset hashes, and the Release body matches this version's CHANGELOG.
  These remain explicitly unsigned installers, per the existing distribution
  contract.
- Physical Win/Mac retest: user acceptance pending after the new installers.
