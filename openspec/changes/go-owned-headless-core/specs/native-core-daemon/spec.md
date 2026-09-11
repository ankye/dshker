## Purpose

Defines the Go native core that owns DSHKer's networking, reverse proxy, credential storage, and DSH lifecycle, so a machine with no desktop session can still host and reach a DSH workbench.

## ADDED Requirements

### Requirement: Native core owns the remote access path

A single native core process SHALL own the coordinator session, P2P transport, pairing, catalog persistence, the reverse proxy, the SSH tunnel and its descriptor exchange, the DSH child process, and the secret storage those depend on. The core SHALL be usable with no GUI, no window, and no desktop session on macOS, Windows, and Linux.

#### Scenario: Headless host serves a remote session
- **WHEN** the core runs on a machine that has no desktop session and an enrolled device credential
- **THEN** it establishes the coordinator session and accepts a peer connection without any window, display server, or Electron process

#### Scenario: Ownership is not split
- **WHEN** a peer connection is established while no Electron process is running
- **THEN** the pairing record, the pinned peer identity, the proxy binding, and the DSH child are all held by the core alone

### Requirement: Electron starts the core and speaks a bootstrap handshake

An Electron shell SHALL start the core as a child process and SHALL communicate with it over a private local channel established by a one-shot bootstrap. The core SHALL NOT expose a TCP or UDP control surface, and SHALL refuse to serve any channel that was not established by that bootstrap.

#### Scenario: Shell starts the core
- **WHEN** the desktop application starts
- **THEN** it spawns the core, writes one bootstrap record to the child's stdin, and connects to the private local endpoint that record names

#### Scenario: Unbootstrapped control request is refused
- **WHEN** any process attempts to use a known core operation without a valid bootstrap secret
- **THEN** the core refuses the request and reports a typed refusal rather than serving it

#### Scenario: Renderer never receives the core channel
- **WHEN** the renderer asks for any remote, credential, or process operation
- **THEN** it receives only the typed projection the shell already exposes, and never the core's endpoint, secret, or raw result

### Requirement: Native core stores credentials in an OS provider

Device private keys and coordinator session tokens SHALL be protected by the operating system's credential provider — Keychain on macOS, DPAPI on Windows, Secret Service on Linux. The core SHALL NOT write plaintext key material, SHALL NOT fall back to an unprotected store, and SHALL fail explicitly when no provider is available.

#### Scenario: Credential round-trips through the OS provider
- **WHEN** the core persists a device credential and reads it back on a later run
- **THEN** the stored bytes are recoverable only through the OS provider and never appear unprotected on disk

#### Scenario: No provider is available
- **WHEN** the platform credential provider cannot be used
- **THEN** the core reports a typed failure and refuses to persist the credential rather than storing it unprotected

### Requirement: Preserved remote-access invariants

The core SHALL keep the product's existing remote-access constraints: no relay or third-party transit is used, DSH Web stays bound to loopback and is reached only through the established peer or SSH path, and the core never exposes a general filesystem or shell capability to a peer.

#### Scenario: No direct path is available
- **WHEN** two peers share a network but no direct UDP path can be established
- **THEN** the attempt fails with the direct-path refusal and is not silently relayed

#### Scenario: Peer requests something outside the contract
- **WHEN** a peer asks for a path or command outside the authorized roots and the bound project
- **THEN** the core refuses it with a typed refusal

### Requirement: Core records why an operation failed

Every failed operation the core reports SHALL carry the code that describes the actual cause. A transport failure, a missing remote runtime, and an authorization refusal SHALL be distinguishable from the caller's perspective.

#### Scenario: Transport never came up
- **WHEN** a connection attempt ends because the direct path was never established
- **THEN** the caller receives a direct-path failure code and not a runtime-availability code

#### Scenario: Remote runtime refused
- **WHEN** the peer transport is established but the remote side cannot provide a DSH runtime
- **THEN** the caller receives a runtime-availability code
