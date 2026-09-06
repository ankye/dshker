# Managed remote DSH connections

## Ownership

- Electron main owns the remote computer catalog, peer descriptor, peer HTTP endpoint, SCP/SSH command construction, temporary files, tunnel processes, mapped URLs, and shutdown.
- Preload exposes only typed get/create/connect/disconnect/remove operations plus a state projection.
- The renderer owns the Remote Connections presentation and projects fixed Run tabs from main-process state. It never receives executable paths, process arguments, broker secrets, remote filesystem paths, or the original remote URL.
- DeepSeek Harness remains unchanged and continues to own its loopback listener and Web session credential.

## Threat model and credential lifetime

- DSH remains loopback-only on every computer. The peer broker also binds only `127.0.0.1`; SSH forwards bind only `127.0.0.1` at both ends.
- Existing OpenSSH host trust and non-interactive user authentication establish the remote account identity. Strict host-key checking and batch mode are mandatory.
- Every DSHKer process creates a random 256-bit peer secret in `.dshlauncher/remote-peer.json`. SCP retrieves that fixed relative file through the authenticated SSH account. The secret rotates on restart and the descriptor is removed on clean shutdown.
- The peer secret, remote child-announced DSH URL/token, mapped local port, SSH PID, and temporary descriptor are never stored in the remote computer catalog. The temporary descriptor is deleted immediately after connection setup.
- DSH Web tokens appear only in the existing child announcement, the authenticated peer response, main-process memory, and the mapped loopback URL supplied to the Run guest for DSH's normal one-time cookie exchange. They are not written to Launcher logs.

## Process topology

1. Local DSHKer runs SCP with an exact argument array to copy `.dshlauncher/remote-peer.json` into an owner-only temporary directory.
2. Local DSHKer starts one supervised SSH process forwarding a local loopback port to the descriptor's remote loopback broker port.
3. Local DSHKer authenticates to `POST /v1/runtime/connect`. Remote DSHKer returns its running DSH announcement or starts its own managed runtime and waits for that announcement.
4. Local DSHKer validates HTTP(S), loopback host, and explicit remote port, then starts a second supervised SSH process for that exact port.
5. Only the validated remote URL authority is replaced with the second local-forward authority; path and query credential remain unchanged.
6. Disconnect, quit, stale generation, or either SSH exit stops both process trees and clears transient authority.

## Rejected alternatives

- LAN binding (`--host 0.0.0.0`) was rejected because DSH exposes command-capable APIs.
- Copying SSH private keys or writing `authorized_keys` was rejected; DSHKer uses the user's existing OpenSSH identity/agent only.
- Password entry and interactive SSH prompts were rejected; missing authentication fails explicitly.
- An unauthenticated loopback peer endpoint was rejected because another same-host process could request the DSH credential without reading a protected descriptor.
- A remote shell helper was rejected because GUI package paths and default remote shells differ between macOS and Windows.
- Disposable browser tabs were rejected because closing a tab would hide a live managed tunnel and break one-computer/one-workspace identity.

## Connection test and status semantics

- Test Connection runs the complete production SSH/peer/DSH-forward sequence and then stops its temporary tunnels; a shallow socket or ping fallback is not accepted as proof.
- Test state is process-local and separate from live tunnel state. It never persists a URL, token, local port, process id, or diagnostic payload.
- Disconnected and failed live states are shown red, ready is green, and connecting is an explicit in-progress color; every color is paired with localized text.
