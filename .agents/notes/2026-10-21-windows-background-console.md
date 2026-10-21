# Keep Windows local runtime commands in the background

## Cause and authorized scope

The user reported a native console window appearing during local DSH startup on
Windows and authorized a fix. The supervised Go runtime child had no explicit
window suppression; local port inspection and process-tree cleanup also created
console commands independently. The visible output belongs in Launcher Console
and logs.

The change is limited to `networking/internal/harnessruntime`: the Windows
supervised child receives `HideWindow` and `CREATE_NO_WINDOW`, and port inspection
and `taskkill` share the platform-owned `backgroundCommand` constructor. The
non-Windows constructor remains ordinary `exec.Command`; the supervised child's
POSIX process group and signal handling remain unchanged.

Preserve executable/arguments, stdout/stderr pipes, URL readiness, actual output
and exit/error readback, existing Stop/tree cleanup, logs and independent runtime
ownership/attachment/survival. Do not change SSH flows, other product domains,
user terminal preferences or explicitly interactive applications. No shell wrapper
or renderer capability is added.

## Verification

The complete harnessruntime race suite passed in 5.365 seconds: 56 named tests
and subtests, zero failures. Its raw output is retained in
`.run/windows-background-console-race.jsonl`. Native background lifecycle tests
exercise two rounds of a real Windows console-subsystem root/grandchild tree and
one standalone command probe. All five receipts report `GetConsoleWindow` as
zero while stdout/stderr, readiness, exit and tree cleanup assertions pass.

`GetConsoleProcessList` reported one PID belonging to the calling probe. It is
recorded as an observation, not interpreted as a console window or required to
be zero. The first run's incorrect zero-process-count assertion failed; that raw
failure is preserved at `.run/windows-background-console-initial.jsonl`. The
corrected oracle uses the actual console HWND and preserves the process-list
receipt instead of relabeling its nonzero count.

Final combined default test-integrity verification passed with seven declared
test files, one real command and two evidence artifacts. It retains the prior
authorized-network-recovery evidence and the new Windows execution output at
`.run/windows-background-console/runtime.jsonl`; the verification receipt is
`.run/windows-background-console-test-integrity.txt`.

The native core built successfully with SHA-256
`f610fdf5b544f78ba04efffbd3009d5723ec7ba623aa645788b32ff081787a2f`.
The same binary passed all five headless-core smoke observations in 1.482 seconds,
including authenticated named-method access, typed refusal and graceful handoff;
raw evidence is `.run/headless-core/latest.json`. Vet and all five affected/new
code-file size checks passed. The Darwin ARM64 harnessruntime test binary
cross-compiled successfully; this is compilation proof, not a macOS runtime pass.

Independent review found no blocking issue. Production dependency inspection
covered 334 packages and found no dependency on the test-only console probe;
the production harnessruntime file set excludes the test and probe entry. The
same native binary contains none of five exact test/probe markers. These results
are retained in `.run/windows-background-console/source-isolation.json` and
`.run/windows-background-console/artifact-isolation.json`. The probe lives under
testdata and is explicitly compiled by tests, not an application fallback.

Scoped formatting, strict OpenSpec validation and `git diff --check` pass.
Task temporary storage uses the designated NTFS data drive, with the Go cache
on the separate data drive.

Prior authorized-network-recovery changes and their retained broad-check
limitations remain intact. This note does not claim installation, publication,
physical ICE or eight-hour acceptance.
