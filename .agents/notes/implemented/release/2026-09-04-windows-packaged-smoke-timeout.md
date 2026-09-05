# Windows packaged smoke startup budget

## Context

The `v0.1.7` tagged package reached the Windows installer build and metadata
checks, but its packaged application smoke exited without writing launch
evidence. The runner step lasted about 23 seconds, matching the previous
20-second child timeout plus the evidence wait, while the stderr warning hid the
actual child-process timeout message.

## Decision

`tools/release-smoke.mjs` accepts an explicit `--launch-timeout-ms` budget and
retains the child error text alongside stderr. The package workflow keeps the
20-second macOS budget and gives the Windows native runner a 60-second budget so
normal hosted-runner startup variance remains bounded and visible. The Windows
package smoke remains a hard prerequisite for the publish job.

## Follow-up diagnostics

The first `0.1.8` retry still exhausted the 60-second Windows budget without a
launch payload. The smoke now records native startup stages and BrowserWindow
load events in `packaged-launch.json.trace`, which the workflow copies into its
diagnostic artifact.

The `0.1.9` trace showed that Windows completed renderer load, route smoke, and
height adaptation, then stalled waiting for the first animation frame after a
resize. The smoke window was fully outside the virtual desktop at negative
coordinates; `0.1.10` keeps it at `(0, 0)` and records the paint/capture
boundaries so the compositor can continue producing evidence.

The first four-platform `0.1.11` run built the macOS Intel DMG but failed during
the height-adaptation probe with `Object has been destroyed`; its Windows ARM
seed preparation also hit a transient `EBUSY` lock while removing the clone.
`0.1.12` lowers the smoke-only native minimum height to the probed 420px and
uses bounded `fs.rm` retries for the Windows temporary clone cleanup. The retry
did not clear the Windows ARM runner lock, and the Intel Mac smoke still timed
out after the height probe. `0.1.13` sizes the smoke window to the native
display work area and defers only an explicitly reported Windows `EBUSY`/`EPERM`
temporary-clone cleanup.

The `0.1.13` retry still failed before publication: macOS Intel continued to
tear down during native frame resizing, while Windows ARM did not leave a
diagnostic artifact. `0.1.14` resizes the BrowserWindow content area rather
than its title-bar-inclusive frame and reports any Windows cleanup error while
preserving the original seed operation result.

## Verification target

The `0.1.14` tag must produce successful macOS arm64/x64 and Windows x64/arm64
packaged smoke evidence, followed by one public latest GitHub Release. A failed
smoke still blocks publication and leaves its diagnostics as a traceable Actions
artifact.
