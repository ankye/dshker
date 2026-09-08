# P2P helper integration — implementation in progress

## Scope

Enrollment domain continuation: local pending readback cannot establish server
absence. Same-revision authoritative absence enables one explicit submission;
permission is consumed before dispatch and invalidated by a new readback.
Lost replies and failed recovery preserve uncertainty. Busy operations cannot
overwrite reconciliation state. Test-only API doubles cover these transitions;
they do not prove real enrollment UI or two-App acceptance. First-use versus
deleted-credential history remains an explicit release gap, not a missing-file
fallback. No release or completed-task claim is made for this increment.

Validation for this increment: `npm test -- --run` with the canonical macOS
temporary directory passed 118 files / 805 tests (including 8 enrollment domain
tests). `npm run type-check`, `npm run architecture:check`, targeted Prettier,
`git diff --check`, and OpenSpec strict validation passed. The two enrollment
source files are 96 and 157 physical lines. Real Electron interaction, full
two-App enrollment and final package gates were not run for this increment.

Continue `add-self-hosted-p2p-dsh-connections`. The user selected a GitHub
prerelease for Win/Mac testing after full local implementation and validation.
No stable feed update is authorized by that selection.

New production Go modules provide a private main/helper RPC endpoint, helper
dispatch, peer session composition, stream-to-net.Conn adaptation and a gateway
restricted to an explicitly bound loopback DSH runtime. Credentials remain in
the main/helper channel rather than public connection state. Windows uses a
current-user named-pipe ACL; Unix uses a private directory and socket.

## Correctness fixes and focused evidence

- Serialize request ID allocation through wire submission, retaining concurrent
  response handling. Bidirectional test performs 800 calls and checks payload
  identity, not just response counts.
- Preserve authentication reader lookahead; test a pipelined first request and
  rejection of a wrong bootstrap secret.
- Reject malformed/duplicate/unknown RPC fields and non-public response errors;
  redact internal handler errors and reject cancelled calls before admission.
- Serialize operations per stream direction so deadline cancellation slots
  cannot be overwritten by concurrent readers/writers.
- Fence gateway admission against shutdown so late sockets cannot escape cleanup.
- Bind pinned identities to network, account, participants, revision and public
  keys. Correct the Ed25519 Equal argument type: a plain byte slice had rejected
  identical valid keys. Rejected updates preserve the existing pin; owned copies
  prevent a caller mutating stored key bytes after admission.

Commands from `networking/`:

```sh
go test -race -count=1 ./internal/localrpc ./internal/runtimebridge ./internal/peersession
go vet ./...
GOOS=windows GOARCH=amd64 go build -o <temporary-output>/dshker-peer.exe ./cmd/dshker-peer
```

The focused tests passed after fixing the public-key comparison defect. RPC and
gateway tests also passed three consecutive race-enabled runs before adding the
identity tests. The Windows command proves compilation, not Windows execution.
The gateway tests use real Pion transport with a test-only HTTP oracle; they are
not real DSH or packaged Electron acceptance. Changed-source size measurement
reported 16 files and zero violations of the 1000-line limit.

## Lifecycle continuation

Replaced the uncancellable nil reservation with an owned session before Begin.
Disconnect now waits for cleanup completion, and Manager.Close waits for all
owned sessions. Cleanup includes the renewal worker. Target invalidation also
cancels owner calls that have not yet returned their runtime binding; stale
credentials are rejected. Unrelated outgoing sessions remain independent.
Failed terminal state is retained instead of overwritten by disconnected.
The authenticated path check must succeed before entering runtime negotiation.

Added `networking/integration/runtime_session_test.go` with real coordinator,
two Go managers, five reconnect cycles and a real DSH restart. Extended diagnostic
passed under race detection; details are in `docs/testing/p2p-runtime-session.md`.
The first lifecycle test run exposed a test HTTP handler that had not consumed
its request body and therefore blocked server shutdown. The handler now consumes
the body, has bounded teardown and asserts remote request cancellation; no
production timeout was relaxed. `go vet` prompted explicit context ownership in
`newSession`, and passed after that correction.

## Remaining release blockers

### Formal management owner and network revocation continuation

`electron/main.ts` now creates `PeerManagement`, which owns the catalog,
credential store, supervised helper, trusted services, user sessions and enrollment
workflow. It starts the helper lazily for explicit operations. Helper failure
closes the account/enrollment/service owners so memory tokens and late operations
cannot survive the failed helper. Normal shutdown closes this management owner
before the managed DSH runtime. Named IPC and renderer integration are still the
next required layer; no renderer receives the private RPC or enrollment grants.

Confirmed server network deletion calls the new named `network.invalidate`
operation before persisting matching local computers as revoked. Go removes the
selected network's pins, cancels even pre-Begin reservations and waits for cleanup;
network/pair tombstones prevent stale repinning. Repeated cleanup uses retained
pair ownership to wait for already-unpinned sessions. Other networks remain pinned.
A configured service without a device manager owns no local peer authority and
acknowledges the explicit empty cleanup. If helper cleanup fails, P2P fails closed;
a subsequent catalog-write failure does not restore helper authority or stop
unrelated networks. Local/SSH remain separate owners.

Five controller contract tests plus existing host/shutdown tests passed (27 cases).
Go peer-session/helper race tests passed. A new real DSH/real coordinator manager
diagnostic proved the old gateway closed, remote DSH remained usable and repinning
or reconnecting the revoked network failed. The final version also performs real
server network deletion before local cleanup and is included in the full Go run.
The original runtime restart/manager-close diagnostic was retained unchanged.

Full application regression passed 729 tests in 109 files (12.95 seconds).
Type-check, architecture, environment, disabled-service smoke, Electron build and
diff checks passed. Source-size measurement covered 68 files without violations.
Rebuilt macOS arm64 helper digest:
`f19323b8e2f57f5822d9b3dc71d3c495d69510f04190b25470542040966d2d15`.
Actual-helper key/CSR/admission/shutdown diagnostics passed. These results are not
the full double-App workbench or interactive release acceptance.

### Main enrollment workflow continuation

Added `PeerEnrollment` to compose existing service trust, account admission,
credential persistence and named helper operations. Fresh registration persists
the original key/request before obtaining a grant; explicit pending submission
reuses that identity and rebuilds its CSR. Recovery only queries the original
request and never requests another token or re-enrolls automatically. The write
response, independent signed-query result and local credential readback must
agree before reporting registration. Public projections exclude private keys,
certificates and grants. Missing query results remain typed errors with the
pending identity intact.

Seventeen test-only dependency-contract cases passed, covering ordered durable
writes, failed secure storage, ambiguous enrollment, recovery without replay,
explicit resubmission, stale revisions, changed user, all returned identity
fields, conflicting query/readback, service locks, cancellation during storage
and helper closure with a delayed key response. Type and architecture checks
passed. These tests do not exercise a real server through this new TypeScript
orchestrator. It still needs formal controller/IPC/UI ownership, registration
state refresh after helper restart and complete real-server/UI validation.

Full app regression passed 724 tests in 108 files (10.81 seconds); source-size
measurement covered 63 files with no violations. OpenSpec strict validation,
changed-file formatting and diff checks also passed. No release gate was waived.

### Original-key CSR and enrollment-grant admission continuation

Added named main/helper `device.createCSR`: it accepts only the saved raw
Ed25519 key over the authenticated private channel, verifies seed/public-suffix
integrity and regenerates the CSR without replacing identity. The helper now
rejects key/configuration operations after closure or pre-admission cancellation.
Go helper tests parse and verify real CSR signatures/public keys, reject corrupt
or missing keys and extra fields, and exercise cancelled/closed admission.
Controlplane/helper race tests and `go vet` passed. The real rebuilt helper
diagnostic verified eight original CSR readbacks plus strict RPC and shutdown;
the real server enrollment readback/restart regression passed in 3.308 seconds.
Current macOS arm64 helper digest:
`9ad654363de98ff93e92df3b8c884d97c8d8e3e0f7af8d061f1d05ee9cbf4c14`.

`PeerAccounts.enrollmentGrant` is a main-only registration capability. It checks
the pending identity's original user, reads ownership of the requested network,
then validates the returned token, exact network and expiry. It must not be bound
directly to renderer IPC or state. Five new tests cover ownership, changed user,
unknown network and malformed grants; the account suite passed 19 tests.
Formal enrollment orchestration and public UI are still pending; no registration
or release task is completed by these prerequisite checks.

Full application regression passed 707 tests in 107 files (14.10 seconds).
Type-check, architecture, OpenSpec strict validation and diff checks passed;
source-size measurement covered 61 files without violations. This round did not
rerun the full three-minute Go suite after the CSR change; it ran the focused
race, real-server readback/restart, actual-helper diagnostic and vet checks above.

### Enrollment result and pending-secret continuation

Connected the client's named `device.enrollmentResult` helper operation to the
existing standalone server's `/v1/enrollment-query` contract. The helper signs
the original request ID and current query time using the original Ed25519 key;
the HTTPS request contains public proof, never the private key or enrollment
token. Returned identity/certificate is checked against that key and the pinned
authority. No server source import, server edit or token-consuming retry was added.

`TestEnrollmentResultReadbackAndServerRestart` uses the real server and checks
exact device/user/name/key/certificate readback, rejection for another key or
request, preservation across server restart, no duplicate device and continued
single-use token rejection. The test oracle retains the initial response; this
is independent recovery readback, not an injected network reply-drop test.
Focused race passed; the full Go race suite also passed with integration taking
187.565 seconds. `go vet ./...` passed. The rebuilt macOS arm64 helper digest is
`1e45366597febeb619f4c2162678290ad5a7be2a20bb48852e6abb93374dcff9`.

Added an encrypted pending-enrollment state to the main credential owner. It
persists original request/key/user/network/name before token use and atomically
transitions the same file to issued credentials using revision and identity
checks. Explicit persisted-format dispatch distinguishes pending/registered;
missing or invalid state is not treated as a fresh registration. Fourteen schema
tests cover missing/forbidden fields, key integrity and input preservation.
The real two-Electron-process storage driver also passed pending create/restart,
no plaintext secrets, rejected stale/wrong-user/wrong-name completion, successful
completion readback and prevention of pending overwrite after completion.

Main registration orchestration, CSR reuse, result-unknown UI, actual reply-drop
injection and Windows secure storage still need implementation/verification.
These results do not complete task 3.1 or the public registration workflow.

The final app regression passed 702 tests in 107 files (14.25 seconds), with
type-check, architecture, changed-code formatting and diff whitespace checks
passing. Source-size measurement covered 59 code files without violations.
The rebuilt helper also passed the actual runtime-host key/admission/shutdown
diagnostic. No prerelease was created; full interactive evidence remains absent.

### Formal main lifecycle composition continuation

`electron/main.ts` now owns `PeerRuntimeHost` with the real managed runtime,
registered settings-root catalog and explicit development/packaged resource
location. Construction is idle; an explicit main P2P operation must enable the
catalog and start the verified helper. Callback admission reads the current
catalog, rejects unknown/revoked/forgotten pairs, fences state by attempt and
generation, and rechecks a runtime binding after asynchronous authorization.
No URL/token is present in the status projection. Runtime retirement calls the
actual helper managers that requested this local runtime. Invalidation failure
closes the helper and marks P2P failed rather than keeping stale readiness.

Normal shutdown now attempts every connection owner's cleanup before DSH,
including when another owner fails synchronously or asynchronously. It aggregates
the original failures rather than skipping Local/SSH or claiming clean shutdown.
The focused P2P/shutdown suite passed 111 tests in 9 files. The added host driver
uses a real `LauncherHarnessService`, real catalog and actual Go helper: eight
concurrent key requests, strict admission, unchanged catalog readback, no implicit
DSH start and completed shutdown passed. The first driver bundle lacked Node
`require` for a bundled CommonJS dependency; adding the standard `createRequire`
banner fixed the diagnostic build, without modifying production behavior.

This is not full App/workbench acceptance. Named IPC/UI/account composition,
enrollment recovery, explicit helper restart and guest/remote-project workflows
remain incomplete. No task is marked complete or release-ready from this result.
See `docs/testing/p2p-runtime-session.md` for the reproducible diagnostic command.

Current full regression passed 688 tests in 106 files (11.14 seconds), with the
canonical system TMPDIR used for existing path-identity tests. Type-check,
architecture, environment, disabled-template-service smoke, Electron production
build, changed-file formatting and OpenSpec strict validation passed. Source-size
measurement covered 54 changed code files with no violation. The initial shutdown
implementation used `AggregateError`, which the current TypeScript library target
does not declare; the corrected named `LauncherShutdownError` preserves all
original failures and passed type-check plus the full rerun. These are diagnostic
and regression results, not full test-integrity/interactive release approval.

### Safe storage and user-management continuation

The credential creation path now syncs a complete temporary ciphertext before
exclusive hard-link publication, preserving an existing record on duplicate
registration. Credential names/certificate sizes are bounded. A real Electron
safeStorage diagnostic passed in two independent macOS processes: encrypted
create, strict duplicate/stale/key-mismatch rejection, replacement and restart
readback, corrupt-record rejection without automatic reset, and deletion.
Test certificates are explicitly self-signed test-owned identities; this proves
storage, not coordinator authorization. The first certificate-generation run
failed with the system LibreSSL; the diagnostic now requires an explicit
Ed25519-capable OpenSSL path and was run with installed OpenSSL 3.6.3. No
production dependency or fallback was added. Windows DPAPI remains untested.

Added Go client/helper operations for current user/logout, network rename/delete,
device inventory/bind/unbind and network pair list/delete. A real independently
running server readback test passed under race detection (2.05s test body),
checking public keys, account/network identity, no-op rename, binding removal,
unrelated-network preservation and logged-out token rejection. Pair deletion is
implemented but not yet included in that focused readback scenario.

These components still need the main-owned service/catalog workflow and public
UI integration; they are not a completion claim for the full goal.

### Service and actual runtime ownership continuation

Added `PeerServices` to connect the real catalog contract to named helper
configuration. First verified addition requires explicit P2P enable and a current
catalog revision; no caller key is accepted. Reopening uses the persisted pinned
key and independently checks returned CA/key/endpoint shape. Forgotten identities
cannot reuse a previously configured helper client. Ten contract tests use a
test-only RPC double and real temporary catalog files, not a real TLS server.
Unverified/offline configuration drafts, endpoint editing and complete enrollment
are still implementation work, not silently substituted by this verified path.

The existing production `LauncherHarnessService` now publishes its actual launch
state to main-only listeners. `PeerRuntimeOwner` uses that source for exact URL
and generation binding, synchronous retirement, shared cold start, independent
cancellation and original precondition failures. It does not poll or infer a port
from saved settings, and never stops DSH on cancellation. Eight focused lifecycle
tests cover running/cold/external start, restart, timeout, cancellation and close.
At that checkpoint formal main/helper callback wiring was missing; the later
main lifecycle continuation above adds it, but does not complete the workbench.

Validation: related tests passed 140 cases in 9 files. Full app regression via
`TMPDIR=<canonical system temporary directory> npm test -- --run` passed 665 tests
in 104 files, exit 0. Type-check and architecture checks passed. Source-size gate
measured 47 changed code files, zero violations; the touched runtime service is
979 physical lines and must be split before any growth above 1000. One negative
service-input test initially failed TypeScript excess-property checking; its
untrusted input was moved to an explicit variable without weakening runtime
unknown-field rejection, and type-check was rerun successfully.

No whole-feature acceptance or release is claimed. The user reiterated complete
production integration; remaining main/IPC/preload/UI, credential recovery,
pairing/guest/project behavior and final local gates must all be implemented.

### Main account orchestration continuation

Added `PeerAccounts` and strict account/network response parsers. Contracts were
checked against independent server `internal/coordinator/users.go`, `networks.go`
and the public Go client's JSON types. Usernames, 64-hex session tokens, password
byte limits, stable user/network IDs and network display fields are not invented
from UI state. The server remains independent and was not modified.

Sessions are main-memory-only. Login validates an independent current-user
readback, expired tokens are not sent, logout clears local authority even if the
server is unavailable, and helper closure cannot be undone by late replies.
Per-service locks reject conflicting operations without locking another service.
Network mutations read back the exact ID/owner/name; no-op rename is read-only,
unknown targets and foreign/duplicate records fail. Confirmed deletion invokes a
required owner cleanup callback before list readback; a later failure cannot
restore authorization or automatically repeat the mutation.

Fourteen focused contract tests use test-only RPC doubles; they do not claim real
network or UI evidence. The full P2P TypeScript subset passed 70 tests in 5 files;
type-check, architecture check and source size (42 measured files, no violations)
passed. Server configuration lifecycle, device enrollment, production main/IPC/UI
composition, real account-orchestration integration and complete workbench gates
remain unfinished. No acceptance checkbox, commit or release is inferred.

### Catalog persistence continuation

Added explicit enable marker/catalog identity matching, strict schema parsing,
revision-fenced serial atomic commits and post-write readback. Missing one of the
registered files fails rather than recreating it. Queued inputs are copied before
asynchronous work; no-op commits preserve the file timestamp. SSH bytes are not
touched. Persisted service CA DER is canonical and self-signed, and its Ed25519
key must match the declared service identity. Expiry remains a live-authentication
concern rather than a reason to erase persistent configuration.

The persistence boundary now rejects pair identity replacement, revision rollback,
revoked-to-active transitions, active-record removal and deletion of a service
before a separate durable forget tombstone. Cleanup cannot remove the tombstone
or reintroduce forgotten trust. Main workflows must still perform authorization,
connection cleanup and affected-record locking before committing.

Validation: `npm test -- --run electron/main/p2p` passed 52 tests across 3 files,
including 27 new catalog tests using test-owned temporary filesystem records.
`npm run type-check` and `npm run architecture:check` passed. These tests prove
module behavior, not two-App UI integration, Windows filesystem/DPAPI behavior,
the one-hour workbench soak, full regression or release readiness. No new feature
checkbox or release is claimed. Service lifecycle orchestration and typed IPC
remain the next integration work.

### Electron module continuation

Supervisor cleanup continuation: extracted private channel ownership and tested
the Windows pipe prefix by exact character codes against the Go contract. After
the child exits, the supervisor now closes its RPC and performs idempotent owned
cleanup automatically. Unix crash residue is removed only if `peer.sock` is an
actual socket in the launch-owned directory; regular files, symlinks and unrelated
contents are not recursively deleted. Startup rechecks cancellation after private
channel authentication so a cancelled launch cannot return an admitted supervisor.

Four channel tests passed, including a real test-owned socket process killed with
SIGKILL and subsequent path/connection checks, plus preservation of substituted
and unrelated files. This test process is a filesystem lifecycle oracle, not the
Go helper or a full App. Rebuilt darwin-arm64 helper and reran the production
supervisor driver: eight parallel key requests, invalid/cancelled admission and
shutdown passed against the actual Go executable. `npm run type-check` passed.
Windows pipe execution and full App helper-crash UI recovery remain unverified.

Full Go rerun after the GracefulClose fix: from `networking/`, with explicit
`DSHKER_SERVER_BINARY` and `DSHKER_TEST_HARNESS_ROOT` pointing to the actual local
server and managed Harness, `go test -race -count=1 -timeout 8m ./...` exited 0.
Integration completed in 186.703 seconds; controlplane, localrpc, peer,
peersession, protocol and runtimebridge packages passed. The helper package and
command have no Go test files; the separate real-helper TypeScript driver is
diagnostic coverage, not an assertion of exhaustive helper operation coverage.
The original reconnect resource budget was unchanged. This supersedes the
earlier full-suite failure for the current Go source but not the missing
one-hour production-App workbench soak or Windows/platform gates.

The complete local P2P TypeScript subset now passes 56 tests across four files;
architecture check passed. The quality-engineering source-size gate measured 39
changed code files with zero violations (1000-line limit). Strict OpenSpec,
changed TypeScript formatting and `git diff --check` passed. The complete
interactive manifest/ledger remains absent and final quality acceptance is not
approved by these diagnostic results.

Added main-only strict wire parsing, bounded symmetric RPC and an owned helper
supervisor. The child is selected only from main-owned platform resources after
manifest/hash validation; bootstrap secrets travel through stdin and the private
socket, not argv. Added `tools/build-peer-helper.mjs` to produce generated helper
resources and metadata under ignored `build/p2p/` for explicit target arguments.

`tests/runtime/peer-helper-driver.ts` exercised the actual Go helper with the
production TypeScript supervisor and RPC: eight distinct concurrent generated
key identities, invalid fields, cancelled admission, shutdown and subsequent
unavailability. Its classification remains diagnostic, not Electron acceptance.
Protocol and RPC tests: 25 passed. App type-check and architecture check passed
before the later credential-store addition, which requires renewed checks.

The full Go suite earlier failed the 30-reconnect goroutine budget. Pion's normal
Close does not join its workers; the transport now invokes GracefulClose outside
callbacks and joins its lease worker. Three repeated race-enabled load/reconnect
runs passed unchanged budgets, with receiving goroutines 42 to 44 rather than
42 to 70. Full-suite rerun on the final candidate remains required.

Added main-only safeStorage credential persistence with strict encrypted records,
identity/key/certificate checks, revision-fenced updates and readback. Real
Keychain/DPAPI validation and service workflow composition remain incomplete.

The workspace validator was executed and remains red: existing documentation
contains machine-specific paths; its text scan also flags the generated Go
binary and portable JSON-escape/Windows pipe syntax. These findings have not
been waived or counted as acceptance. The app architecture command was first
invoked from the workspace by mistake, then rerun successfully from the app.

Electron supervisor, fixed helper resources/hash checks, secure persistence,
full management UI, remote directory grants, production guest registration and
real DSH/session wiring in Electron are not complete. A complete committed test-integrity
manifest, production-composition E2E, real DSH soak/stress and package gates are
still missing. No completion checkbox or release readiness is inferred from
these module results. No release was published by this implementation step.

## Versioned management IPC and frozen preload continuation

### Renderer management continuation

### User and network controls continuation

- Added explicit per-service account entry and user/current/login/logout/network-list/select/create/rename/delete controls to the formal Remote route. No default network is selected. Public fields use typed locale dictionaries; actual IDs/names come from main readback. Password input is cleared on submission/unmount and excluded from shared domain state.
- Network delete confirmation names the network and revocation consequences. Unconfirmed write outcomes retain previous data and block further writes until network-list readback, not merely user readback. Failed listing never becomes an empty list. User identity changes clear the old network context. A removed confirmation target restores focus to the owning account heading.
- Fixed main account recovery: an explicit user-unauthorized/session-expired error clears only that service's cached login, allowing a subsequent explicit login. Ordinary server unavailability does not discard cached authority. This preserves precise existing errors rather than replacing them with a generic network failure.
- Added six account-domain tests, three public-control component diagnostics and two main recovery tests. The relevant 30 tests and type-check passed before the final complete regression. The UI tests use test-only bridge doubles; no real two-App or physical UI evidence is implied.
- Complete app regression passed 117 files / 797 tests; type-check, architecture and Electron production build passed, with 94 changed code files under the source-size limit. Strict OpenSpec and formatting checks passed. Focus assertions are component diagnostics, not physical keyboard or geometry acceptance.
- Device enrollment/pairing controls, endpoint editing/forgetting, connection/fixed-guest/project integration, actual UI input/bounds evidence and the remaining complete-release gates are still pending. The overall objective remains active and no release was created.

- Added the shared remote-connections P2P owner and mounted a real service-management component in the existing Remote route. It calls the production frozen API for catalog inspection, explicit enable, and verified service addition; no test data or hidden network implementation enters production.
- The domain keeps one document-wide request sequence, separate per-service operation state, catalog readback and non-secret service drafts. Missing bridge/method fails explicitly. Rejected concurrent calls do not replace the active state. Accepted cancellation remains pending until the original outcome; a late cancellation error cannot overwrite a newer result. Lost write replies are unconfirmed and never automatically replayed.
- Product behavior follows the existing operational layout, spacing tokens and typed Chinese/English dictionaries. Service identity/endpoints are displayed verbatim from main readback; they are not a green remote connection. Public forms preserve input on failure, include readback/cancel controls, and announce pending/error status semantically. The experience-design review guided these states; live bounds and keyboard/focus evidence are still required.
- Eleven new domain/component diagnostic tests cover not-enabled versus failed/missing state, exact field readback, service-scope concurrency, no credential state, request sequencing, late cancellation, save uncertainty and preservation of drafts. These test-only bridge doubles are not real server or packaged-App proof.
- Complete app regression passed 115 files / 786 tests with canonical macOS TMPDIR. Type-check, architecture check, Electron production build, strict OpenSpec and targeted formatting passed; source-size gate measured 90 changed files, zero failures. No Go source changed in this continuation.
- Remaining UI includes user/network/device/pairing/editor workflows, fixed tabs and remote project controls. No task completion, candidate E2E approval, prerelease or final quality claim is made.

- Formal `registerIpc` now owns 15 named P2P management handlers through the existing `PeerManagement` instance; the production preload exposes a frozen `p2pManagement` object, not a generic helper/RPC entry.
- Shared v1 request contracts require a strictly increasing positive request ID per top-level document. Main checks the real sender policy, exact fields and endpoint/identity/text limits before calling any owner. Page scopes permit 16 pending operations, preserve a cancellation path at capacity, and retire on main navigation, renderer loss or destruction. Old-document calls are rejected until the next DOM is ready.
- A 120-second outer management budget requests cancellation without extending shorter helper deadlines. Accepted writes cancelled or timed out are explicitly unconfirmed, never reported rolled back or automatically replayed. Completion still waits for the owner; cancellation of another document is rejected.
- Public projections explicitly copy catalog/user/network/registration fields. Certificates, encrypted records, private keys, tokens and runtime URLs stay out. Error codes are allowlisted; raw native/helper exception messages are never returned.
- New tests use test-only owners/Electron boundaries; sender admission exercises the production policy, and the preload test imports the actual production preload. These remain contract/regression diagnostics, not two-App/UI/server acceptance.
- Full Go race suite completed successfully: integration 195.448 seconds, including actual server network deletion and direct-gateway invalidation. Final app full regression passed 113 files / 775 tests (including 46 new management IPC/lifecycle/projection/preload tests); type and Electron build passed, and the changed-code size gate measured 82 files with no failures. Tests use the canonical macOS TMPDIR to preserve filesystem path identity, without changing assertions.
- Still missing: renderer domain and complete management UI, pairing/connection/browser/project composition, full interactive manifest/ledger, two-App production E2E, one-hour stress and final package/platform gates. No release or completion claim.

### Windows compatibility continuation

Windows cannot always create ordinary directory symlinks without Developer
Mode or elevation, so the catalog and runtimebridge security tests fall back to
junctions while retaining the same containment assertions. The runtimebridge
now resolves Windows reparse points through the kernel final-handle path before
checking root containment; the non-Windows path keeps EvalSymlinks. Catalog
replacement also preserves the old record while swapping files on Windows,
where rename cannot overwrite an existing destination.

The rebuilt win32-x64 helper passed its checksum preflight. Full application
regression passed 1000 tests with two unrelated environment skips; the focused
P2P subset passed 384 tests. Runtimebridge, peersession and helper race tests,
type-check, architecture, formatting, builds and strict OpenSpec validation
passed. A live Electron development window mounted the P2P management panel;
the Windows host still needs a reachable WSS/STUN coordinator and a second
physical computer for end-to-end pairing acceptance.
