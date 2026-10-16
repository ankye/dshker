## 1. Core certificate lifecycle

- [x] 1.1 Implement authenticated query, renewal and recovery clients with full certificate and identity validation; verify real TLS and negative certificate tests.
- [x] 1.2 Add canonical credential ownership, durable metadata/readback and a main-only certificate RPC; verify stale shell, partial persistence, authorization and restart tests.
- [x] 1.3 Maintain certificates at restore and during online/headless operation without replacing peer managers; verify cancellation, concurrency and race tests.

## 2. Desktop synchronization

- [x] 2.1 Synchronize the public certificate with revision checking and full credential readback; verify per-service single-flight, stale identity and failed-storage tests.
- [x] 2.2 Preserve login/enrollment ownership and provide actionable typed refusal copy; verify unreadable bootstrap never registers, restoration after login and locale/component tests.

## 3. Integration and delivery

- [x] 3.1 Verify the separate server's real query and existing renewal/recovery contracts against local client/core processes, including lost-response and restart identity continuity.
- [x] 3.2 Update both READMEs, CHANGELOG and Agent Note; verify OpenSpec strict, source-size and default test-integrity gates.
- [x] 3.3 Run required source tests, type/architecture/format/smoke checks and source builds, review changes, then commit/push and tag for GitHub Actions packaging; record Windows/macOS CI and published Release evidence independently of manual cross-machine acceptance.

## 4. Legacy selection migration follow-up (0.1.90)

- [x] 4.1 Resolve only an authenticated account's explicitly remembered network after the exact legacy expiry refusal, freshly verify ownership and original-device binding, cancel changed scopes and schedule recovery after manual selection; pass focused unit and management tests without changing existing identity fields.
- [ ] 4.2 Add real expired-legacy CLI/OS credential recovery and restart tests against the independent coordinator, preserving device/key/network/pair identity and proving missing/unauthorized scope refusal.
- [ ] 4.3 Update version, both READMEs, CHANGELOG, Agent Note and test integrity bindings; pass default verify, required full checks, source-size and independent security review.
- [ ] 4.4 Commit and push, tag the exact stable version, complete GitHub Actions packaging and verify public stable Release assets and checksums; leave physical Win/Mac acceptance explicitly separate.
- [ ] 4.5 Close runtime hash input handles before verified-stage publication, prove immediate rename/removal without retries, and pass actual Windows packaging after the CI stage-rename failure.
