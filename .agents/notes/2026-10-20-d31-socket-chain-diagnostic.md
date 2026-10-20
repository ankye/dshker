# D31 retained failure; D32 diagnostic-only boundary

Client HEAD `484898305ac3eacec1e8ebcbdd77d0ee6e24a151`, source digest
`b49a53b2b960a2fc13eeca05faf18904bc5c60ded32dbefb259dfff5ad4c41f8`, and
independent server HEAD `9665b122899ef58be109e9ff16bbedc90a57708d` have passing
exact-SHA CI. Local joint integration passed six groups/eight named cases. These
are not physical, native interaction or overnight acceptance.

The sole D31 physical program run `ad1c3b36-9230-4a78-948b-00bb21a582b8` remains
FAIL. Short and long recovered in 766ms and 1000ms; short retained its original
WS, long used automatic WS replacement. Flap failed initial ICE before any fault
was injected. All six native safety preflights passed. Evidence is retained in
`.run/open-workbench-recovery/d31-program-pause-20261020/`; neither the failed
aggregate nor the failed capture-preservation guard attempts is overwritten.

The final capture continuation succeeded after two separately retained guard
failures. It did not repeat stop, converted once, checked both copied hashes and
removed only the exact owned Windows filter. The Mac user's bounded capture is
still running. The final packet evidence and independent analysis are under
`.run/open-workbench-recovery/d31-capture-continuation2-20261020/`.

Observed flow `10.147.17.110:57350 -> 10.147.17.251:56948` first has two ordinary
Binding successes. The next ordinary request, then 129 nominations over 24.446s,
have no matching responses in the retained captures. The 27 cross-host matched
nominations have identical packet bytes and valid captured IPv4/UDP checksums.
USERNAME hashes reverse consistently; MI admission is unknown. The failure's
Mac all-goroutine stack shows an idle Agent task loop and 19 readers, not the
exact failing socket's read/close lifetime. The Mac capture excludes ICMP4.
No kernel delivery, read-error, socket-close, validation or deadlock cause is
proven. Source inspection excludes shared Agent/static credential ownership, not
all physical socket or protocol failures. `go mod verify` passes on the pinned
module cache; dependencies were not modified.

D32 therefore adds a separate diagnostic-only Go overlay of the app's own
SettingEngine construction. Its transparent real stdnet wrappers must preserve
all I/O returns, AddrPort paths and deadlines. Fixed records retain exact socket
and attempt identity without payload/SDP/USERNAME/password/raw errors. A positive
BindingRequest callback is not proof of response delivery. Bounded nonblocking
output must expose loss, with no completeness claim after overflow/write failure.
The overlay, private operator and helpers need their own hashes and must never
be labeled a normal production or release acceptance run.

Root owns planning and operator; the focused worker owns only ignored overlay
helpers/tests. A second investigator supplied a read-only lsof/PID mapping design;
no lsof execution or additional source mutation is implied. No original app,
credentials, network, firewall, power policy or server is operated. New physical
execution requires helper tests and independent review first. No eight-hour run,
deployment, new tag or Release has occurred.

## D32 observer preflight

The ignored helper was frozen with artifact-list SHA
`b5d8ae45ab0c269befa5933f56b6cbff7b52c42c4b236b5c6c5296a4f12d7d5d`.
Ten focused Go pure/real-UDP loopback cases passed with race instrumentation;
Windows helper/core cross-compilation passed but those binaries were not executed.
Independent static review closed the observer and operator's I/O, lifecycle,
redaction, output-completeness and hash-coverage boundaries. None proves the
original socket cause or production recovery.

An extra actual local two-Pion DTLS/data-channel test passed once, with two
complete observer footer/end pairs and zero lost records. Its external guard
nevertheless failed because the existing legacy unit uses a 12-hex attempt ID,
whereas the initial collector assumed every attempt was a 32-hex v2 nonce.
The failure is retained under `.run/d32-ice-socket-local-peer-20261020/`.
No network test was rerun: a distinct read-only continuation checked the sealed
files under an explicit v1 contract. The collector now requires an explicit
v1-ID or v2-nonce contract; the physical collector remains strictly v2-nonce.
Eight Node pure tests passed; the final delta requires independent review before
physical execution. Missing footer/end, overflow, failed output or mismatched
identity still makes evidence incomplete.

The new exact-SHA Mac DMG was downloaded and verified, not locally packaged.
Native UI continuation is blocked by the Mac lock screen and awaits the user's
manual unlock; no password was requested. The production coordinator's verified
Linux CI artifact has been prepared separately, but upload/switch and its live
protocol readback have not run. These boundaries remain independent of D32.

## D32 single physical diagnostic and retained first socket boundary

Runner `a6c61a4b-536a-471e-9760-e1e5c37e763e` / PID55499 finished once with
exit1 at 2026-10-20T13:32:54Z. Source `b49a53b2…`, server `09d0021d…`, all
nineteen observer/operator inputs and three compiled binaries stayed unchanged.
Short and long failed initial setup before fault injection; flap passed. The
aggregate remains FAIL and explicitly diagnostic-only, never release/8h proof.

For short attempt `2b67e634129c941a4047fc85faef3c3f` / generation25277418287,
both Mac and Windows observer footer/end pairs are complete with zero drops.
The later cleanup successor has incomplete logs; the whole case observation is
therefore incomplete. Mac PID55667/socket2/fd14/local10.147.17.251:58082 read two
ordinary requests and two nominations. The nominations reached Pion's positive
post-validation callback, but their matching success writes returned n0/errno65.
The following real ReadFromUDPAddrPort call stayed pending 26.20770925 seconds
until cleanup. During it, the Mac interface captured 133 complete valid-checksum
nomination requests and an ordinary success which never appeared as socket reads.
Every first read error/deadline/Close is teardown, not an earlier termination.
This rules out the earlier early-recvLoop-exit hypothesis for this attempt and
locates a delivery boundary; it does not establish the OS/netpoll/privacy cause.

The single Windows capture stop/conversion/copy/exact-filter removal succeeded;
final PktMon is stopped and its filter list empty. ETL/PCAP and a bounded,
non-atomic Mac ring snapshot are retained under
`.run/open-workbench-recovery/d32-capture-preservation-20261020/`. The original
Mac capture remains running. Independent packet/socket evidence and hashes are
under `.run/open-workbench-recovery/d32-short-socket-analysis/`. No network test
was rerun after this failure.

A single bounded read-only macOS15.7.9 system-log query retained local-network
code-attribution messages in the matching interval, but no test-PID/port or
explicit denial match. It cannot establish permission state. Apple's TN3179
describes responsible-app attribution and kernel-stack local-network checks;
neither that documentation nor errno65 proves this occurrence is privacy-related.
No defaults, TCC, firewall, network, power or signing setting was changed. Native
UI remains blocked by lock screen pending the requested manual unlock.

## Independent coordinator deployment and online gate

CI `39421401847` Linux amd64 binary SHA
`d5a21c287a8d742413f8d7cc8c043a6b6af00a4d4f4ee33a8eb40657f0a3a5f7`
was uploaded exclusively, with a matching stopped-state old executable/database/
identity/config/TLS/unit backup. Only the binary was replaced and started once.
The original deployment operator failed a transient listener-row parser guard;
that FAIL is retained without retry, rollback or editing its operator. A distinct
read-only continuation proves new PID843620, disk and /proc SHA, each TCP/UDP8443
owner, trusted HTTPS, nonce/service identity and unchanged fixed files/schema7.
The transient unretained ss row's exact format remains unknown.

After that readback, the sole approved online gate passed in6.50s: actual trusted
TLS, mTLS WSS101, exact v2 lifecycle/refusals, and two same-Mac production Hosts
with real DSH bidirectional HTTP/WS in2196/2215ms within their original25s budget.
No native secret provider was opened. Pair, both bindings and network belonging
only to the new test scope were deleted, Networks read back empty and Logout
succeeded. The new account `49f2634ce6d7` and two device records are retained,
not falsely reported deleted; no user-disable or broad database cleanup ran.
Source/binary/operator inputs stayed fixed; the test process group is empty with
no cleanup signal. Evidence lives in `.run/d32-server-deployment-20261020/`.
This is deployed protocol/same-Mac DSH proof, not Mac-Win, overnight or installed
UI acceptance. No new tag or GitHub Release has been published.
