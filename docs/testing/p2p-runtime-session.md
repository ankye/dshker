# P2P runtime session diagnostic

This is a Go integration diagnostic, not packaged desktop acceptance. It uses
the independently built production coordinator, two production peer session
managers and an explicitly selected real DSH CLI. It does not simulate DSH HTTP
or WebSocket responses and does not submit model tasks.

## Inputs and command

Build the independent `dshker-server` first. Select the intended built Harness
checkout explicitly; no global DSH executable or alternate checkout is chosen.
From `networking/`, set both required absolute paths:

```sh
DSHKER_SERVER_BINARY=<absolute-server-binary> \
DSHKER_TEST_HARNESS_ROOT=<absolute-built-harness-checkout> \
go test -v -race -timeout 150s ./integration -run '^TestManagerRealDSH$'
```

The full Go suite now requires both inputs:

```sh
DSHKER_SERVER_BINARY=<absolute-server-binary> \
DSHKER_TEST_HARNESS_ROOT=<absolute-built-harness-checkout> \
go test -race -count=1 -timeout 8m ./...
```

Each DSH process gets a temporary project and isolated `DSH_HOME`; the selected
checkout and normal DSH data are not rewritten. The startup URL is consumed only
in process memory and is not printed. Temporary certificates and pairing data
are test-owned and are not production resources.

## Assertions

- Real server enrollment, approval, fingerprint confirmation and pair readback.
- Five explicit connections with distinct attempts and exact pair/generation.
- Authenticated real DSH HTTP/Cookie and WebSocket probes through Pion transport.
- Disconnect removes the loopback gateway, and the remote DSH remains available.
- Actual DSH process restart plus runtime invalidation closes the old attempt.
- Reconnect uses the new runtime generation and newly announced credential.
- Manager close removes the gateway without stopping the new DSH process.

Reconnects are paced at one second, below the server's 20 requests per source
per second admission limit. A rejected request fails the test; there is no
automatic retry. An initial unpaced run hit the real `p2p.rate_limited` response.

Focused lifecycle tests additionally cover cancellation while Begin is pending,
duplicate admission, HTTP request cancellation readback, stale owner results,
and invalidation isolation across local/outgoing runtimes.

## Evidence boundary

The extended diagnostic passed locally with the race detector in 12.84 seconds
(13.863 seconds including the test runner). This is not the one-hour soak, a
two-Electron-process run, remote directory/project interaction, or physical
Windows/macOS testing. Full test-integrity and interactive release gates remain
required before publishing the prerelease.

## Main runtime-host diagnostic

`tests/runtime/peer-runtime-host-driver.ts` exercises the production host with a
real managed-runtime owner and Go helper, using a temporary registered catalog.
It does not start DSH or two Apps and is not workbench acceptance. Run from the
app repository with explicit absolute output/resource paths:

```sh
npx esbuild tests/runtime/peer-runtime-host-driver.ts --bundle --platform=node \
  --format=esm \
  --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --outfile=<absolute-temporary-output>/driver.mjs
node <absolute-temporary-output>/driver.mjs <absolute-helper-resources-root>
```

The resource root is the directory containing `p2p/<platform>-<arch>/`, with the
binary and generated integrity manifest from `tools/build-peer-helper.mjs`.
The local macOS arm64 run passed: explicit-enable rejection, eight distinct
concurrent key identities, unknown-field rejection, unchanged persistent catalog,
no implicit DSH start, closed RPC and no restart after owner shutdown. No private
keys are logged or persisted by this diagnostic. Windows remains unexecuted.

## Network deletion and local authorization cleanup

`TestManagerNetworkRevocationRealDSH` is a separate Go diagnostic, preserving the
original runtime restart and manager-close assertions. It starts the real DSH,
coordinator and two managers, proves authenticated HTTP/WebSocket traffic, deletes
the actual server network, then waits for local network revocation cleanup. It
checks the old gateway is closed, the remote manager observes disconnection,
stale pins and reconnection are rejected, repeated cleanup is safe and the actual
DSH process remains available. It is included in the full Go command above.
Other-network pin isolation is covered separately by peer-session unit tests;
this one-pair diagnostic does not claim a multiple-network App UI acceptance.
