## Purpose

Enable one DSHKer Launcher to manage several trusted computers and open each computer's loopback-only DSH Web session through authenticated, supervised SSH tunnels without manually copying DSH session credentials.

## ADDED Requirements

### Requirement: Explicit remote computer catalog
The Launcher SHALL let the user register multiple computers with an explicit display name, SSH host, SSH port, and SSH user. It SHALL persist stable computer identities and those connection fields, and SHALL NOT persist SSH passwords, private keys, DSH session URLs, DSH session credentials, local forwarding ports, or child-process identifiers.

#### Scenario: Register a computer
- **WHEN** the user submits a unique display name, valid SSH host, port, and user
- **THEN** the Launcher persists one computer record and immediately creates its fixed Run tab in a disconnected state

#### Scenario: Reject incomplete or ambiguous input
- **WHEN** any required field is missing, malformed, duplicated, or outside its admitted range
- **THEN** the Launcher rejects the request with a typed validation error and does not infer or substitute a value

#### Scenario: Restore registered computers
- **WHEN** the Launcher restarts with a valid catalog
- **THEN** it restores every registered computer as disconnected without restoring a session credential or tunnel

### Requirement: DSHKer peer credential exchange over SSH
Each Launcher SHALL publish an authenticated peer descriptor in its Launcher-owned directory and expose a versioned peer endpoint on loopback only. A connecting Launcher SHALL retrieve that descriptor through the authenticated SSH file-transfer channel, forward the described loopback endpoint through SSH, authenticate with the descriptor secret, and request the exact DSH URL announced to the remote Launcher.

#### Scenario: Remote runtime is already ready
- **WHEN** the SSH file transfer, host verification, peer protocol, and peer authentication succeed and the remote DSH runtime is already running
- **THEN** the peer returns the exact current child-announced loopback URL without requiring the user to copy its DSH credential

#### Scenario: Remote runtime must start
- **WHEN** an authenticated peer requests a session while the remote Launcher runtime is stopped
- **THEN** the remote Launcher starts its own managed DSH runtime and returns only after that child announces a valid loopback URL

#### Scenario: Peer authentication fails
- **WHEN** the descriptor is missing, unreadable, malformed, has an unsupported protocol version, or its secret is rejected
- **THEN** the connection fails with a typed peer error and no DSH URL or credential is returned

#### Scenario: SSH prerequisite fails
- **WHEN** OpenSSH, strict host-key trust, non-interactive SSH authentication, file transfer, or forwarding is unavailable
- **THEN** the connection fails with a typed SSH error and does not ask for a password, disable host verification, or choose another transport

### Requirement: Loopback-only supervised tunnels
The local Launcher SHALL supervise a broker forward and a DSH Web forward for each connected computer. Every local and remote forwarding endpoint SHALL bind to loopback, and the Launcher SHALL preserve the remote URL path and query while replacing only its loopback authority with the supervised local forwarding authority.

#### Scenario: Remote session becomes ready
- **WHEN** the remote peer returns a valid loopback HTTP or HTTPS DSH URL and the DSH forward becomes reachable
- **THEN** the connection enters ready with one local loopback URL that preserves the remote path and query credential

#### Scenario: Remote peer returns an unsafe URL
- **WHEN** the peer returns a non-HTTP scheme, a non-loopback host, a missing explicit port, or malformed session URL
- **THEN** the Launcher rejects it with a typed protocol error and stops every process created for that attempt

#### Scenario: Tunnel exits
- **WHEN** either supervised SSH process exits while the computer is connected
- **THEN** the computer enters failed, its Run tab remains present but non-browsable, and all processes from that connection generation are stopped

#### Scenario: Disconnect a computer
- **WHEN** the user disconnects a connecting, ready, or failed computer
- **THEN** the Launcher stops its SSH process trees, clears in-memory URLs and credentials, and retains the computer record and fixed Run tab as disconnected

### Requirement: Fixed local and remote Run tabs
The Run page SHALL contain exactly one permanent Local tab and one permanent tab for every registered remote computer. These workspace tabs SHALL be created automatically, SHALL NOT expose close or add-tab controls, and SHALL remain visible through local runtime stops, remote failures, route changes, and application restarts.

#### Scenario: Local runtime is stopped
- **WHEN** the Local tab is selected while local DSH is not running
- **THEN** the tab remains selected and shows an explicit start-local-runtime action instead of being removed

#### Scenario: Remote computer is disconnected
- **WHEN** a remote tab is selected while its computer is disconnected or failed
- **THEN** the tab shows its exact connection state and a route to manage or retry that computer instead of loading a stale URL

#### Scenario: Remote computer becomes ready
- **WHEN** a registered computer reaches ready
- **THEN** its existing fixed tab automatically loads the supervised local-forward URL and no additional disposable tab is created

#### Scenario: Remove a computer
- **WHEN** the user explicitly removes a disconnected computer from Remote Connections
- **THEN** the Launcher deletes its catalog record and removes exactly that computer's Run tab while retaining the Local tab and every other computer tab

### Requirement: Explicit connection test and status indicators
The Remote Connections page SHALL expose a named test operation for each computer that is not actively connecting or connected. The test SHALL exercise the same authenticated descriptor transfer, peer request, remote DSH URL validation, and SSH forwarding path used by Connect, SHALL stop all test processes before completion, and SHALL NOT leave the computer connected. Test results SHALL remain process-local. The page SHALL show both text and a colored indicator: disconnected or failed connections are red, connected connections are green, and an in-progress connection uses a distinct non-success color.

#### Scenario: Connection test succeeds
- **WHEN** the user tests a disconnected computer and the complete SSH and DSHKer peer path becomes ready
- **THEN** the Launcher stops the temporary tunnels, leaves the computer disconnected, and shows a green "test passed" result

#### Scenario: Connection test fails
- **WHEN** any SSH, host verification, peer authentication, protocol, runtime, or forwarding step fails
- **THEN** the Launcher stops every process from the test attempt, leaves the computer disconnected, and shows a red typed test failure

#### Scenario: Live connection state is visible
- **WHEN** a computer is disconnected, connecting, connected, or failed
- **THEN** its row exposes the exact state as text plus a red, in-progress, green, or red indicator respectively

#### Scenario: Test conflicts with a live operation
- **WHEN** a test is already running or the computer is connecting or connected
- **THEN** the Launcher rejects another test or connection attempt with `remote.connection_busy`

### Requirement: Named renderer authority only
The renderer SHALL receive only typed catalog projections, connection and test states, and named create, test, connect, disconnect, and remove operations. Electron main SHALL own OpenSSH and file-transfer resolution, subprocess arguments, temporary files, peer secrets, DSH session credentials, HTTP peer calls, persistence, and process shutdown.

#### Scenario: Renderer submits a connection operation
- **WHEN** the trusted renderer submits one admitted request containing only documented fields or a registered computer identity
- **THEN** Electron main validates the sender and payload before performing the named operation

#### Scenario: Renderer attempts to supply authority-bearing data
- **WHEN** a request contains unknown fields, filesystem paths, executable paths, process arguments, URLs, credentials, or an unknown computer identity
- **THEN** Electron main rejects the entire request with a typed invalid-request or not-found error

### Requirement: Cross-platform peer behavior
The peer descriptor, file transfer, SSH forwarding, process lifecycle, catalog format, and browser-tab behavior SHALL have the same contract on supported macOS and Windows architectures. Platform-specific executable resolution SHALL be explicit and SHALL fail when the required OpenSSH tools are unavailable.

#### Scenario: Supported packaged platform
- **WHEN** the feature runs in a supported macOS or Windows package with the required OpenSSH tools
- **THEN** the same catalog, peer protocol, connection states, and fixed-tab acceptance tests pass

#### Scenario: OpenSSH tool is absent
- **WHEN** the platform-specific SSH or SCP executable cannot be started
- **THEN** the operation reports the exact missing-tool category without searching for or substituting another executable
