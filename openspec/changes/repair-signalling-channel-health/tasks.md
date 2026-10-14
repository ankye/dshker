## 1. Socket lifecycle

- [x] 1.1 Networking owner: add bounded ping/pong to the existing subscription heartbeat and preserve typed close causes; verify responsive idle and missing-pong real-socket tests on macOS.
- [x] 1.2 Networking owner, depends on 1.1: verify close while checking, presence rejection, full event queues and explicit superseded handling (including pending pong and initial admission) with race-enabled real TLS/WebSocket tests.
- [x] 1.3 Peer-session owner, depends on 1.1–1.2: stop automatic replacement on a typed superseded admission failure and verify both ordinary health-loss recovery and no superseded re-dial using real TLS/WebSocket tests.

## 2. Verification and delivery evidence

- [x] 2.1 Root owner, depends on 1.1–1.3: independently review cancellation, queue/write concurrency and reconnect ownership; run focused peer supervisor/helper tests and Windows/Linux compilation/vet checks. Physical Win↔Mac acceptance remains a separate deployment gate.
- [x] 2.2 Root owner: update changelog, network documentation, Agent Note and test-integrity manifest; run OpenSpec strict, formatting, architecture and source-size checks. Record that the currently installed process is not yet this build and keep its active DSH session running.

## 3. Requested stable release

- [x] 3.1 Release owner: commit and push version 0.1.88 with matching lockfile and localized changelog, then verify same-commit Linux/Windows Quality and the actual peer integration step before pushing the exact v0.1.88 tag.
- [x] 3.2 Release owner, depends on 3.1: wait for the tag-specific package/publish workflow, verify a public stable latest Release with all 25 expected assets and matching checksums/manifests, and record evidence without packaging locally or restarting the active DSH session.
