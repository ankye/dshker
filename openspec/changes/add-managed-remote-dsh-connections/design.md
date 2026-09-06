## Context

See [proposal.md](proposal.md) for motivation and [specs/managed-remote-dsh-connections/spec.md](specs/managed-remote-dsh-connections/spec.md) for behavior. Today the Launcher supervises one local `dsh web --no-open` child and admits only that child's exact announced loopback URL into a disposable-tab Run page. Electron main owns child processes and credentials; the renderer has no SSH, network, filesystem, or arbitrary command authority.

The user already has ordinary SSH access to each target computer. The missing piece is transporting the remote Launcher's exact announced URL and credential, then forwarding the corresponding remote loopback port. DSH must remain bound to loopback because its Web API can execute tools and commands.

## Goals / Non-Goals

**Goals:**

- Treat a remote computer as a durable Launcher workspace with explicit disconnected, connecting, ready, and failed states.
- Use the user's existing OpenSSH configuration, agent/key identity, and known-host trust without collecting a password or private key.
- Exchange the remote DSH session URL between two Launchers without logging or persisting it.
- Keep the peer endpoint and both ends of every forward on loopback.
- Preserve one stable, non-removable Run tab per workspace identity.

**Non-Goals:**

- Discover computers automatically on the LAN.
- Bootstrap SSH server setup, copy private keys, change `authorized_keys`, accept a password, or bypass host-key checks.
- Expose DSH or the peer broker on a LAN interface.
- Synchronize Harness installations, settings, sessions, or files between computers.
- Stop the remote DSH runtime when one client disconnects; the remote Launcher retains ownership of its local runtime.

## Decisions

### Decision: OpenSSH is an explicit native prerequisite

Electron main launches the platform OpenSSH `scp` and `ssh` clients directly with argument arrays and no shell. macOS uses the fixed system executable paths. Windows uses the fixed OpenSSH command names supplied by the operating system. Both run in batch mode and require strict host-key verification, so an unknown host or missing non-interactive identity is an error rather than a password prompt or trust downgrade.

The connection record contains separate validated `host`, `port`, and `user` fields. None can inject an option because each is passed after the fixed option set and host/user syntax rejects control characters, whitespace, leading dashes, separators, and URL syntax.

Alternative considered: embed an SSH library. Rejected for this change because it adds native authentication and agent compatibility surface while the user's existing OpenSSH command already proves the intended transport.

Alternative considered: `StrictHostKeyChecking=accept-new`. Rejected because silently trusting a first-seen host would make DSH credential delivery depend on an unconfirmed identity.

### Decision: A short-lived peer descriptor bootstraps authenticated Launcher-to-Launcher exchange

On startup, each Launcher creates a cryptographically random peer secret and a versioned descriptor at `.dshlauncher/remote-peer.json`. The descriptor contains only protocol version, loopback broker port, Launcher instance identifier, and the short-lived bearer secret. Atomic replacement and owner-only POSIX mode prevent partial reads; the secret rotates every Launcher process start and is deleted on clean shutdown.

The local Launcher copies that fixed relative file from the authenticated remote SSH account into a private temporary directory using SCP. It validates the exact schema, starts an SSH loopback forward to the advertised broker port, and calls the broker with the bearer secret. The descriptor and secret remain in Electron main and are deleted after parsing.

The broker accepts only loopback TCP peers and exact bearer authentication. It exposes one versioned `POST /v1/runtime/connect` operation: return the currently running local DSH URL or start the Launcher-owned runtime and wait for its own valid child announcement. No general process, filesystem, settings, or DSH API proxy exists.

Alternative considered: an unauthenticated loopback broker. Rejected because another local process could collect the DSH session credential without reading a protected Launcher file.

Alternative considered: invoke a remote GUI executable or shell helper through `ssh host command`. Rejected because package installation paths and remote shells differ across macOS and Windows; SCP of a relative home-directory descriptor and TCP forwarding are supported by OpenSSH on both.

### Decision: Two supervised SSH generations make the dynamic DSH port explicit

The first SSH process forwards a locally reserved loopback port to the peer broker. After the authenticated broker returns the remote child-announced URL, main validates HTTP(S), loopback hostname, and explicit port. A second SSH process forwards another locally reserved loopback port to that exact remote port.

The browser URL is derived by copying the validated remote URL and replacing only hostname and port with the second forward's `127.0.0.1` authority. Its path, query, fragment, and scheme are preserved. This is an explicit remote-session mapping, not the local-runtime fallback forbidden by the existing launch contract. The remote announcement remains the only source of the DSH port and session credential.

Each attempt receives a generation. State changes, child exits, broker responses, and cleanup apply only to that generation. Any failure stops both SSH process trees and clears all transient authority. Disconnect does the same but settles as disconnected.

Alternative considered: restart one SSH process after learning the DSH port. Rejected because it creates an avoidable gap in the authenticated peer channel and complicates failure attribution.

Alternative considered: expose remote DSH with `--host 0.0.0.0`. Rejected because it would move a command-capable API onto the LAN and make DSH authentication dependent on network perimeter behavior.

### Decision: Catalog persistence excludes authority-bearing runtime state

`remote-connections.json` below the Launcher settings root is a strictly versioned record with exact-field validation and atomic writes. It persists only stable ids, display names, hosts, ports, and users. Missing files create the initial empty catalog; malformed, unsupported, or unknown-field records fail the entire capability and are never repaired or partially accepted.

All restored records begin disconnected. Broker secrets, copied descriptors, DSH URLs/tokens, local ports, SSH PIDs, and errors are process memory only. Removing a computer is admitted only after its tunnel generation is stopped.

### Decision: Fixed workspace tabs are projections, not user-created browser state

The Run state derives its tab list from two authoritative sources: the fixed Local identity and the current remote connection catalog. Stable string ids (`local`, `remote:<connection-id>`) replace incrementing disposable ids. The tab title comes from the local locale label or the registered remote display name. A tab has a URL only while its source is ready.

The Run strip has no new-tab or close controls. Local stop, remote disconnect, failure, and route unmount preserve the tab and selection. Removing a registered computer removes its one tab; if it was selected, focus moves to Local. Selecting a non-ready tab shows a task-specific state with a visible route back to Launch or Remote Connections.

The Remote Connections route is a dense operational list with an add form and per-row state/action. Submit, connect, disconnect, retry, and remove each have distinct pending and error states. The user-entered fields remain after a recoverable validation or connection error. Keyboard focus, labels, non-color state text, and disabled repeated actions follow existing shell controls.

Alternative considered: keep disposable browser tabs and add remote URLs to them. Rejected because tab identity would drift from managed computer identity, closing a tab would hide a still-connected tunnel, and restarts would lose the workspace map.

### Decision: Renderer authority remains named and versioned

The preload adds only `getState`, `create`, `connect`, `disconnect`, and `remove`, plus a state-change subscription. Requests contain either the four catalog fields or one stable connection id. Strict parsers reject arrays, nulls, unknown keys, and authority-bearing fields. The main process never sends the peer secret or the remote child-announced URL; ready state contains only the local loopback forwarding URL needed by the constrained Run guest.

The browser continues accepting only loopback HTTP(S) navigation. External links remain outside the guest and use the existing named external-link path.

### Decision: Test Connection uses the production connection path and owns no durable tunnel

`test` is a separate typed IPC operation admitted only by a registered connection id. Electron main runs the same `OpenSshRemoteConnector.connect` sequence used by Connect, including SCP descriptor retrieval, strict SSH authentication and host verification, peer bearer authentication, remote DSH readiness, URL validation, and both loopback forwards. After readiness it immediately stops both forwards before reporting success. It never replaces a failed step with a shallow TCP probe.

Each computer has a process-local test state (`untested`, `testing`, `passed`, or typed `failed`) separate from its live tunnel state. A successful real Connect also proves the path and marks the test state passed. Tests are rejected while a connection is connecting or ready, and Connect is rejected while a test is active. Disconnect and application shutdown abort an in-flight test through the same generation fence and abort controller used for connection setup.

The list renders a textual live state plus a semantic dot: disconnected and failed are danger red, ready is success green, and connecting is accent colored. Test state has its own labeled badge with neutral, accent, green, and red variants. This keeps the result understandable without color while satisfying at-a-glance red/green monitoring.

## Risks / Trade-offs

- [The remote Launcher is not running] → SCP cannot retrieve a current descriptor, so the attempt fails as peer unavailable; no stale descriptor or alternate command is used.
- [The remote Launcher restarts during connection] → its secret rotates and broker/tunnels fail; generation cleanup clears the local URL and retry retrieves a fresh descriptor.
- [A local port is claimed between reservation and SSH bind] → the SSH generation fails explicitly and is cleaned up; the user retries rather than silently choosing another port inside the same attempt.
- [OpenSSH authentication needs interaction] → batch mode fails and reports authentication unavailable; DSHKer never opens an invisible password prompt.
- [A same-user process reads the protected peer descriptor] → it has equivalent access to Launcher-owned state; rotation, restrictive file permissions, loopback binding, and non-persistence limit reuse.
- [HTTPS remote URL certificate names do not match the local forwarded authority] → the current DSH Web contract is loopback HTTP; a future HTTPS mode requires an explicit certificate and origin design before support.
- [Remote DSH continues after disconnect] → this preserves remote ownership and other local clients; stopping a remote runtime requires a separate explicit capability.

## Migration Plan

1. Add the new catalog and peer descriptor formats without changing existing Launcher or Harness records.
2. Ship the peer broker in every supported package so a remote machine becomes connectable after upgrading and starting DSHKer.
3. On first use, create an empty remote catalog; existing users retain one Local Run tab.
4. If rollback is required, stop all tunnels and remove only the new remote catalog and ephemeral peer descriptor. Existing Harness source, native DSH home, settings, plugins, and sessions remain unchanged.
