## Purpose

Keep existing desktop and headless peers reachable across device certificate expiry without replacing their identity or weakening coordinator authentication.

## ADDED Requirements

### Requirement: Certificates renew before expiry
The core SHALL renew an authentic device certificate within the server's seven-day renewal window during startup and sustained operation, using the original device key. It MUST leave an otherwise valid certificate unchanged outside that window.

#### Scenario: Running peer approaches expiry
- **WHEN** an enrolled online or headless peer enters the renewal window
- **THEN** its certificate is renewed and durably read back without replacing its device ID, public key, network, pair revisions or active peer sessions

#### Scenario: Renewal is not due
- **WHEN** a valid certificate has more than seven days remaining
- **THEN** maintenance does not issue a replacement certificate

### Requirement: Expired recovery is authorized and preserves identity
The core SHALL recover only an otherwise authentic original device identity, using an explicitly supplied existing network and an authorized account grant. It MUST NOT use expired credentials for mTLS, guess another network, skip validation or re-enroll a replacement identity.

#### Scenario: Expired registered device has recovery authorization
- **WHEN** the original key is retained and the account is authorized for the exact existing network
- **THEN** the recovered certificate validates for that same key and device and the original network and pairs remain intact

#### Scenario: Login or network authorization is missing
- **WHEN** an expired device lacks the exact network or authorized login
- **THEN** an actionable typed recovery error is returned and all credentials, enrollment and pair records remain unchanged

### Requirement: Partial success can be read back
The client SHALL authenticate current-certificate queries with the original device key and validate returned identity and certificate authority. A query MUST NOT issue a certificate or consume a recovery grant.

#### Scenario: Recovery response is lost
- **WHEN** the server committed recovery but its response or local persistence failed
- **THEN** retry or restart reads back and verifies the committed certificate without consuming another grant or replacing the device

#### Scenario: Returned certificate is untrusted
- **WHEN** a response has a wrong CA, device ID, key, usage, invalid signature or invalid validity state
- **THEN** the client refuses activation with a typed error and never installs unverified data

### Requirement: Canonical and desktop credentials cannot diverge silently
The Go-owned canonical certificate SHALL be preserved against older desktop copies. Desktop synchronization MUST verify identity, revision and complete stored readback while retaining all other fields.

#### Scenario: Desktop restarts with an older certificate
- **WHEN** the same device/key already has a verified newer canonical certificate
- **THEN** the desktop synchronizes that certificate without downgrading it or changing the original network and credentials

#### Scenario: Storage is unreadable or writes fail
- **WHEN** credential readback fails or an operation is stale
- **THEN** maintenance reports the exact typed failure, does not report success and does not start a replacement enrollment

### Requirement: Maintenance respects process and account ownership
Certificate maintenance SHALL be serialized per service and bound to the core lifetime on macOS and Windows. Failure or cancellation MUST NOT start or stop DSH, terminate active peer managers, clear an unrelated valid login or keep work alive after core shutdown.

#### Scenario: Concurrent or cancelled maintenance
- **WHEN** startup, reconnect and periodic maintenance overlap or the owning process closes
- **THEN** at most one issuance owner runs and cancelled or stale work cannot overwrite a newer certificate
