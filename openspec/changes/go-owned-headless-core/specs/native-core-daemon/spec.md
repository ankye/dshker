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

The core SHALL keep the product's remote-access constraints: the peer path prefers a direct UDP/ICE connection and falls back to the deployment server as an opaque relay (TURN, RFC 8656) that forwards only the end-to-end encrypted packet stream (DTLS/SCTP ciphertext) and can neither read nor inject traffic; DSH Web stays bound to loopback and is reached only through the established peer (direct or relayed) or SSH path; loopback-only validation of a resolved route stays; and the core never exposes a general filesystem or shell capability to a peer.

#### Scenario: No direct path is available
- **WHEN** two peers share a network but no direct UDP path can be established
- **THEN** the attempt falls back to the deployment server's opaque relay; if neither
direct nor relayed path can be established, the attempt fails with
`p2p.direct_unavailable` and the relay never sees plaintext

#### Scenario: Peer requests something outside the contract
- **WHEN** a peer asks for a path or command outside the authorized roots and the bound project
- **THEN** the core refuses it with a typed refusal

### Requirement: Headless commands reuse persisted configuration

The core SHALL persist the operator's explicit choices in its state directory and SHALL reuse them on later invocations, so a command that was once configured runs without repeating its arguments. Each value SHALL be resolved by precedence: an explicit flag, then the persisted value, then a documented default. An explicit flag SHALL overwrite the persisted value for later runs. The configuration file SHALL live beside the endpoint record under the same owner-only permissions and SHALL NOT contain passwords, session tokens, or private key material. A required value that is neither supplied nor persisted and has no default SHALL remain an explicit typed refusal; the core SHALL NOT infer a directory, executable, service, or port.

#### Scenario: First run records the operator's choices
- **WHEN** the operator supplies the Harness checkout, the pnpm executable, and the service identity explicitly
- **THEN** the core performs that operation and persists those values as the defaults for later runs

#### Scenario: Later run needs no arguments
- **WHEN** the operator repeats a command that was already configured, with no flags
- **THEN** the core resolves every value from the persisted configuration and runs without asking for them again

#### Scenario: Explicit flag overrides and updates the record
- **WHEN** the operator passes a flag whose persisted value differs
- **THEN** that invocation uses the supplied value and the persisted configuration is updated to it

#### Scenario: Missing required value is still refused
- **WHEN** a required value has never been supplied, is absent from the configuration, and has no default
- **THEN** the core refuses with a typed code and does not guess the value

#### Scenario: Configuration never holds a secret
- **WHEN** the operator signs in or enrolls a device and the configuration is written
- **THEN** the file contains no password, session token, or private key, which stay in the OS credential provider

### Requirement: Core keeps authorized pairs connected

The core SHALL own reconnection for every pair its catalog authorizes, so a headless host recovers a dropped connection with no operator action and no desktop session. A dropped connection SHALL be retried on a widening delay whose final interval repeats while the authorization lasts. A refusal that cannot change by retrying — a withdrawn pin, a revoked network, a revoked or unknown pair, an identity mismatch, or a rejected trust restore or lease — SHALL stop the attempts for that pair and SHALL be reported rather than retried. A change in this machine's own authorization state SHALL clear those stops so a re-authorized pair is attempted again. This reconnection SHALL be one implementation shared by the headless core and the desktop shell; the shell SHALL NOT keep a second private copy of it.

#### Scenario: Headless host recovers a dropped connection
- **WHEN** an authorized pair's connection drops on a machine with no desktop session
- **THEN** the core retries on the widening delay until the connection is re-established, without operator action

#### Scenario: Peer that is simply off does not become a busy loop
- **WHEN** a pair stays unreachable across many attempts
- **THEN** the delay widens to its final interval and repeats at that interval instead of retrying continuously

#### Scenario: Withdrawn authorization stops the attempts
- **WHEN** a connection is refused because the pin was withdrawn or the network was revoked
- **THEN** the core stops attempting that pair and reports the refusal instead of retrying it forever

#### Scenario: Re-authorization resumes attempts
- **WHEN** this machine's authorization state changes after a terminal refusal
- **THEN** the recorded stop is cleared and the pair is attempted again

#### Scenario: One implementation serves both surfaces
- **WHEN** the desktop shell and a headless host both keep pairs connected
- **THEN** both use the core's reconnection, and the same drop produces the same retry schedule and the same terminal-refusal behavior

### Requirement: Core installs its own start-at-boot registration

The core SHALL be able to register and unregister itself to start at system boot using the platform's own mechanism — a launchd agent on macOS and a scheduled task or run-key registration on Windows — and SHALL report whether that registration is currently present. The registration SHALL start the core with its persisted configuration so a rebooted machine serves without an operator. The core SHALL NOT write a registration outside the current user's own scope without explicit elevation, and SHALL report a typed failure when the platform mechanism is unavailable rather than silently doing nothing. The desktop shell SHALL expose this as a settings control that reads and writes the same registration, and both surfaces SHALL report one shared state.

#### Scenario: Operator enables start at boot from the command line
- **WHEN** the operator asks the core to install its start-at-boot registration
- **THEN** the core writes the platform registration, reports it as present, and a later query confirms it

#### Scenario: Rebooted machine serves without an operator
- **WHEN** a machine with the registration installed restarts
- **THEN** the core starts with its persisted configuration and serves its endpoint without an operator action

#### Scenario: Operator disables start at boot
- **WHEN** the operator asks the core to remove the registration
- **THEN** the platform registration is removed, a later query reports it absent, and no orphaned registration is left behind

#### Scenario: Desktop control and command line agree
- **WHEN** the registration is changed from either the desktop settings control or the command line
- **THEN** the other surface reports the same state, because both read and write one registration

#### Scenario: Platform mechanism is unavailable
- **WHEN** the platform's registration mechanism cannot be used
- **THEN** the core reports a typed failure and does not claim the registration was installed

### Requirement: Core records why an operation failed

Every failed operation the core reports SHALL carry the code that describes the actual cause. A transport failure, a missing remote runtime, and an authorization refusal SHALL be distinguishable from the caller's perspective.

#### Scenario: Transport never came up
- **WHEN** a connection attempt ends because the direct path was never established
- **THEN** the caller receives a direct-path failure code and not a runtime-availability code

#### Scenario: Remote runtime refused
- **WHEN** the peer transport is established but the remote side cannot provide a DSH runtime
- **THEN** the caller receives a runtime-availability code
