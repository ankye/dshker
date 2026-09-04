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

## Verification target

The `0.1.10` tag must produce successful macOS arm64 and Windows x64 packaged
smoke evidence, followed by one public latest GitHub Release. A failed smoke
still blocks publication and leaves its diagnostics as a traceable Actions
artifact.
