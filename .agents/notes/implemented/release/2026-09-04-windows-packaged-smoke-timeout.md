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

## Verification target

The `0.1.8` tag must produce successful macOS arm64 and Windows x64 packaged
smoke evidence, followed by one public latest GitHub Release. A failed smoke
still blocks publication and leaves its diagnostics as a traceable Actions
artifact.
