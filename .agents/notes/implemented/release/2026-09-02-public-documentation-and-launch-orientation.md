# Public documentation and Launch orientation

## Context

The packaged app had no bilingual public entry point that described its managed directories, DSH ownership, or unsigned CI artifacts. The Launch page also lacked a concise explanation of the currently selected DSH core and the two project sources.

## Decision

Publish English and Simplified Chinese README and usage guides. Capture product screenshots only from the packaged Electron smoke route. Add a localized Launch-page introduction with the compiled Launcher version, selected-core meaning, preserved `~/.dsh` location, and two fixed GitHub source links. The renderer may request only those named links; the main process resolves them and opens the system browser.

## Consequences

The release package, source repository, and in-app orientation use the same product facts. User-provided URLs never gain an external-navigation capability through the renderer bridge.
