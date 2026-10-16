## Context

See proposal.md. The core has a canonical `account.credential.<serviceId>` record, while older desktops still retain `peer-credential:<serviceId>`. Restoring the desktop copy currently fails when its certificate expires, and could overwrite a renewed canonical certificate. The server already supports renewal and authorized recovery but lacks key-authenticated public certificate readback.

## Goals / Non-Goals

Keep the original machine key, device ID, network bindings and pairs through expiry, process restart and partial writes. Do not restart DSH, replace the peer manager during ordinary renewal, accept invalid certificates, infer a recovery network, or silently re-enroll. The independent server stays Gin/SQLite without workspace/framework runtime dependencies.

## Decisions

### D1. Go owns certificate validity and maintenance

The control-plane client validates the pinned authority, certificate signature chain, CN, original public/private key, ClientAuth usage and current validity. An expired but otherwise authentic credential is admitted only to the explicit recovery state machine, never to an authenticated TLS connection. Renewal runs within seven days of expiry at restore and in a bounded core-lifetime maintenance loop, including headless operation. Per-account serialization prevents concurrent issuance. Certificate replacement uses a synchronized client-certificate callback and closes idle HTTP connections without destroying active peer sessions.

### D2. Authenticated readback closes partial success

The independent server adds `POST /v1/certificate-query` outside its device-mTLS route group. The exact request is `{serviceId,deviceId,publicKey,issuedAt,signature}`. Its Ed25519 signature covers `dshker.certificate-query.v1\n` followed by service ID, device ID, raw-URL-base64 public key and decimal timestamp, separated by newlines. Future timestamps and timestamps at least one minute old fail. The original device key proves ownership; revoked devices and disabled accounts fail. The route returns the current complete public Device, including an expired certificate, and never writes, issues or consumes a token.

Before retrying ambiguous issuance, the core queries and validates the current certificate. A valid newer certificate for the same device/key is durably adopted; a still-expired certificate requires explicit recovery authorization. This replaces blind issuance retries, not security verification. The client's renewal request identity is retained through incomplete operations as necessary. Missing server support is a typed failure, not an alternate server or protocol fallback.

### D3. Recovery requires an explicit existing network and authorized login

If readback remains expired, a named main-only `device.certificate` operation can use a supplied login session token and exact persisted network ID to obtain the server's short-lived enrollment grant. The existing recovery endpoint uses that grant and a CSR signed with the original key. Without those inputs return `p2p.certificate_recovery_required`; authorization rejection returns `p2p.certificate_recovery_forbidden` without signing out a valid unrelated account. Network removal, revocation and malformed certificates remain hard failures. A recovery response is verified and persisted with readback before success.

### D4. Canonical credential and desktop synchronization

The private shell/core RPC accepts scoped `{serviceId,data:{device,privateKey,networkId?,token?}}` and returns exactly `{deviceId,publicKey,certificate}`, with byte fields in standard base64. This supports existing shell-only expired records; no renderer capability or private-key response is added. The Go canonical credential wins for the same verified device/key and cannot be downgraded by an older shell certificate. Conflicting identities fail. Presence reporting for the signed-in user is separate from the certificate's device owner.

Electron serializes each service's maintenance, validates the public response against the original credential, and replaces only the certificate with revision checking and complete readback. A storage failure retains canonical progress for retry. Bootstrap must distinguish an absent credential from an unreadable one; unreadable or expired state never authorizes registration. Existing typed locale dictionaries explain recovery requirements. Successful login schedules restoration without falsely changing login success to failure.

Legacy version-1 canonical credentials retain their exact schema. A separate OS-protected `account.certificate.<serviceId>` metadata record retains the explicitly supplied network and pending request ID; absence means that the older installation never recorded it, not permission to choose a network. Only the new certificate request locally admits the documented optional token/network fields; shared wire decoders stay strict. Same-device/key `device.restore` is explicitly idempotent and preserves the existing manager; a different identity is rejected rather than treating every invalid-state error as already restored.

Older network-join responses projected the network account into `userId`, and older restore paths could persist that value in both shell and canonical records. The leaf certificate binds device CN and public key, not this account field. For same-device/key credentials, use the authenticated query's complete Device as the authoritative original owner, including when both stored copies contain the same projected account. Do not use agreement between the two local copies as owner proof. This read-only normalization may query outside the renewal window, but must not issue a certificate there. Pinned authority, device ID, public/private key and endpoint conflicts remain hard failures. The reported account stays separate, and expiry recovery still requires the exact network's server-authorized grant.

### D5. Ownership, delivery and rollback

Go changes stay under `networking/`; Electron owns main-process credential mediation; shared locale dictionaries own copy. The separate server owns query verification and SQLite reads. Tests use isolated roots and real local TLS/server processes, never production keys. Git commits and CI release follow verified checks; local installer packaging remains excluded. The user subsequently authorized production server deployment while retaining port 8443. Back up the current binary and persistent state, deploy the exact verified CI binary, restart only the independent server, verify health and signed readback, and roll back the binary on failed health checks. Do not regenerate the authority or delete device/network state unnecessarily. Server readback support must be deployed before the new client completes expired recovery. Rollback must not restore an older certificate or delete enrollment state.

## Risks / Trade-offs

- A session may have expired too: show a login-required recovery error and preserve the device.
- A recovery grant can be consumed before the response arrives: query current certificate with original-key proof on the next attempt.
- Keychain persistence or desktop revision can fail after issuance: preserve canonical progress and retry synchronization, never claim success from a write alone.
- Long-lived HTTP/TLS traffic can race renewal: use synchronized certificate snapshots and race tests.
- Different signed-in and original owner accounts exist: preserve device identity and let the server authorize the explicitly selected network; never clear a valid login merely for insufficient recovery authority.
