# D28 native pause verification boundary

Frozen source `904ea974601aabb7b0a2aabdf15515383dbad1b665b456a5b7ac7a57fb1256cb`
at `f70ea2e` ran the sole D27 program profile, runner
`c45b297b-4d45-4fee-aad9-64b4d9eba037`, from 09:19:13Z to 09:23:13Z.
Three-second pause passed with 454ms business recovery and the original WS.
The 35-second pause passed with 828ms recovery; the original gateways, Cookie,
workspace/session and DSH child survived, but its old WS did not. Neither result
claims a continuously surviving long-pause WebSocket or eight-hour acceptance.

The flap case failed its independent parent-gone native safety preflight before
business fault injection. Raw paused.json Open sharing refusal caused the
controller error path to release early; its runner exited without publishing
the paused acknowledgement. The outer wait observed only the file and reported
deadline after 85 seconds, obscuring that earlier child failure. There is no
evidence identifying the conflicting handle holder, a leaked writer, antivirus,
or a production ICE failure. The writer already uses Write/Sync/Close/Rename.

The aggregate remains FAIL. Eight raw artifact hashes were independently
checked; the exact owned Windows temporary roots/processes were absent after
cleanup. The owned PktMon capture stopped, was converted and SHA-verified on both
hosts, and only its exact filter was removed. The original Mac capture and
diagnostic Launcher/core/owner were not changed. Raw proof, failure seal and
packet receipts remain under
`.run/open-workbench-recovery/d27-program-pause-20261020/`.

That freeze is now ended for a test-only D28 repair recorded in the active
design/tasks: first-open READ/WRITE/DELETE sharing for Windows receipt readers,
strict receipt admission unchanged, and an exact early-runner-exit signal at
the awaiting phase. No error retry, timeout relaxation, production runtime or
system network/firewall change is authorized by this repair. Actual Windows
DELETE-handle red/green and early-exit regressions precede a new source freeze.

Quality run `39398875636` passed all three jobs for f70ea2e; package run
`39398875616` also passed all six desktop and six CLI targets. These verify the
preceding candidate, not this later test-helper revision. No crash profile, 8h run,
tag or Release is claimed from this failed physical aggregate.

## Test-helper correction

The Windows receipt reader now requests READ/WRITE/DELETE sharing on its sole
CreateFile, retains native PathError and close errors, and leaves strict receipt
admission unchanged. Other platforms retain os.ReadFile. The exact child's
closed completion channel and original Wait error are observed without consuming
the cleanup join; a missing acknowledgement now reports its named early-exit
phase instead of hiding it behind the deadline.

Native Windows helper tests passed five top-level / 22 total cases. A real
DELETE-access/full-sharing handle makes the old os.ReadFile fail with the exact
sharing error and the new single-open reader succeed. Invalid receipt content
still fails; a genuinely incompatible handle still returns the native sharing
error, without retry. The raw log is
`.run/open-workbench-recovery/d28-helper/windows-receipt-helper-native.log`.
Mac pure helper races passed 13 top-level / 32 total cases. These tests exercise
no original credentials, core business scenario or system network changes.

Independent read-only review found no actionable issue in the seven test-only
files: platform isolation, handle cleanup, exact child ownership and unchanged
guard/schema/nonce/timing admission were checked. No production code changed.
Native helper postflight found zero owned processes and zero remaining scratch
files, with its executable SHA unchanged. The seven changed helper files passed
the 1000-line gate; three-platform live compilation and Mac/Windows vet passed.
Exact source/binary/raw hashes are retained in d28-helper/helper-provenance.json.
A new frozen physical profile remains required; none of this helper evidence is
relabeled as a native core, business pause or crash acceptance pass.
