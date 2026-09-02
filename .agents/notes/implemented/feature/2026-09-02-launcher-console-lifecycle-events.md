# Launcher Console lifecycle events

## Context

`dsh web` normally prints only its command expansion and ready URL. The Console therefore showed a successful startup as two child-output fragments, with no indication of the Launcher work before or after those fragments.

## Decision

The Launcher records its own preflight, child-creation, readiness, stop, failure, and exit events beside child stdout and stderr. These events have a separate `launcher` stream marker in the typed renderer projection and the durable log. A complete one-line pnpm script echo is labeled `command` even though pnpm writes it through standard error. These records describe only actions the Launcher performed; they do not claim plugin-by-plugin DSH loading progress that DSH did not emit.

The DSH Web command has no `--debug` or `--verbose` flag. The Launcher therefore passes its own `--patch` file, which mounts the vendored Cordis console exporter with the debug threshold. The file ships as an application resource and is never written into `~/.dsh` or the selected Git checkout.

## Consequences

Users can distinguish a stalled preflight, a child that has not announced its URL, and a ready DSH Web process. Child stdout and stderr remain intact and separately labeled.

The Console also keeps a bottom runtime action visible beside the scrollable output. It states whether the managed child is stopped, starting, running, or failed, starts only a ready selected version, and changes to the existing stop operation only after that child is running.

Finder does not inherit an interactive shell PATH. The Launcher dynamically resolves pnpm on the current platform and supplies a command PATH to every pnpm child. On macOS and Linux that puts the resolved pnpm directory first, allowing pnpm's `env node` shebang to find the matching Node installation; Windows retains its `.CMD` shim to `pnpm.mjs` path. No platform path is hard-coded as the selected executable.

`--patch` is a DSH Web option, so the invocation is `pnpm dsh web --patch <path> --no-open`. Putting it after pnpm's `--` delimiter let normal Web options through but handed the overlay flag to the Web application, which correctly rejected it as unknown.
