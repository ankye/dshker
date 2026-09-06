## Why

DSHKer users who work across several computers can already reach a remote loopback-only DSH Web instance with a hand-written SSH tunnel, but they must repeat port forwarding and manually obtain the remote DSH session credential. The target user needs every trusted computer to behave as a persistent DSHKer workspace: connect once through SSH, let the two Launchers exchange the announced DSH session address, and open a fixed browser tab without exposing DSH to the LAN.

## What Changes

- Add a fixed Remote Connections route for registering, connecting, disconnecting, and removing multiple computers by explicit SSH host, port, and user.
- Add an explicit one-shot connection test that exercises the same SSH, peer-authentication, DSH-session, and forwarding path as a real connection, then tears the test tunnels down. Show live connection state with a red not-connected indicator and a green connected indicator without relying on color alone.
- Add a Launcher-owned loopback peer endpoint that lets an SSH-forwarded DSHKer request the local Launcher's current DSH session. It returns the exact child-announced URL, including its short-lived Web credential, only over the SSH-forwarded loopback path.
- Add a main-process SSH tunnel supervisor using the operating system's OpenSSH client in batch mode, existing SSH configuration/agent identities, strict host-key verification, loopback-only local forwards, and typed failures.
- Change the Run page to fixed workspace tabs: one non-removable Local tab plus one non-removable tab for every registered remote computer. Tabs remain present while disconnected and become browsable automatically after their connection reaches ready.
- Persist remote computer definitions without passwords, private keys, DSH session URLs, tokens, tunnel ports, or process identifiers. Connection and credential state remains process-local.
- Do not expose DSH directly on a LAN address, transfer SSH private keys, accept passwords in the renderer, or add a non-SSH transport.

## Capabilities

### New Capabilities

- `managed-remote-dsh-connections`: Launcher-to-Launcher peer discovery, remote session acquisition, SSH tunnel supervision, connection persistence, and typed failure behavior.

### Modified Capabilities

None. The related desktop experience, renderer authority, and runtime supervision specifications are still owned by the active `add-managed-harness-desktop-shell` change and have not been archived into main specs. This change's new capability therefore states the complete additive remote behavior without creating invalid deltas against specs that do not yet exist.

## Impact

- **DSHKer Launcher repository:** shared contracts, preload admission, Electron main composition, remote peer broker, SSH tunnel supervisor, persisted remote connection catalog, application navigation, Run page state, locale dictionaries, tests, smoke coverage, and release packaging.
- **DeepSeek Harness repository:** no source change. DSH continues to bind to loopback and remains the sole issuer of its Web session credential; DSHKer transports the already-announced URL without changing Harness authentication.
- **External dependency:** a usable OpenSSH client plus an already trusted host and non-interactive SSH identity are required. Missing executable, host trust, authentication, peer endpoint, or remote runtime readiness fails explicitly; DSHKer does not request a password or choose another transport.
