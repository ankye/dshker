# Self-hosted P2P workbench (in development)

Connect two of your own computers directly, so one can open the other's DSH
workbench without exposing DSH Web to the network and without an SSH tunnel.

> **Status: not released.** The desktop implementation and its automated tests
> are complete, but two-machine acceptance, the four-architecture packaged
> builds and the coordination-server deployment have not been carried out. Do
> not treat this document as a statement that the feature is available in a
> shipped build. A successful installer build is not a successful release.

## What this feature is, and what it is not

It **is** a direct peer-to-peer path between two computers you control, arranged
by a coordination server you host yourself.

It is **not**:

- A way to reach a computer over any network. Direct connections need a usable
  UDP path. Some networks — symmetric NAT on both sides, UDP blocked entirely,
  restrictive corporate egress — cannot be traversed. There is **no relay**, so
  in those networks the connection reports `direct_unavailable` and fails
  instead of silently falling back to a slower path through a third party.
- A sandbox around DSH. Authorized directories only limit the folder picker in
  this app. Once a project is open, conversations, file access and tasks are
  governed by the DSH permission and approval policy **on the other computer**.
  This app does not bypass or weaken it.
- A file manager or a remote shell. The only remote operations are listing an
  authorized directory and opening a project inside it.

## Before you start

You need three things:

1. **A coordination server you host.** See
   [DSHKer Server](https://github.com/ankye/dshker-server). It needs a valid
   HTTPS certificate, a WSS signalling endpoint and a reachable UDP port for
   STUN. Certificate or configuration problems must be fixed on the server; the
   desktop app deliberately refuses to connect to an unverifiable server.
2. **Two computers**, each running this app, each signed in to the same account
   on your server. A computer cannot pair with itself.
3. **DSH able to run on the computer being opened.** The remote side hosts the
   actual workbench; if its DSH cannot start, pairing succeeds but connecting
   will not produce a usable workbench.

## Before you begin: run the preflight check

Two things block a first run more often than anything else: this machine has no
usable peer helper, or the coordination server is not actually reachable. Check
both before you start pairing:

```
npm run p2p:preflight
```

That verifies only the local helper. To check your server too:

```
node tools/p2p-preflight.mjs \
  --https https://your-server.example \
  --wss   wss://your-server.example/v1/signals \
  --stun  your-server.example:3478
```

Add `--json` for machine-readable output. The tool exits non-zero if any check
fails, sends no credentials, and changes nothing.

What the failures mean:

- **Helper missing or checksum mismatch.** Each machine must build its own helper
  for its own architecture; one built elsewhere cannot be copied in. The command
  to run is printed with the failure.
- **TLS certificate not trusted.** Fix this on the server. The app deliberately
  refuses a server it cannot verify, so a self-signed certificate that this
  machine does not trust will not work.
- **No STUN response.** UDP is blocked or the port is closed. This is the usual
  reason pairing succeeds but connecting reports `direct_unavailable`. There is
  no relay, so it must be fixed rather than worked around.

A STUN pass proves this machine can reach the server over UDP. It does not prove
the two computers can reach each other; only an actual connection shows that.

## 1. Add your server

Open **Remote connections → P2P**, then add the server:

| Field                  | Meaning                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| Name                   | Shown on this computer only. Changing it never affects the other computer. |
| HTTPS address          | Where the app reads and writes account, network and pairing records.       |
| Signalling WSS address | Where the two computers exchange connection offers.                        |
| STUN address           | Used to discover a direct path.                                            |

The app pins the server's identity the first time it verifies it. If the same
address later presents a **different** identity, the connection is refused
rather than re-trusted — this is deliberate, and it is what protects you from a
substituted server.

Removing a server marks it permanently untrusted on this computer. Re-adding the
same identity afterwards is refused, so remove one only if you mean it.

## 2. Register this computer and sign in

Sign in with your server account, then register this computer as a device. The
device key is generated locally and never leaves the computer. Registration may
require approval depending on how your server is configured; a pending
registration is not an approved one, and the app says so rather than showing a
green state.

## 3. Pair two computers

Pairing is deliberately a two-sided, explicit process. Neither side can pair the
other unilaterally.

1. On computer **A**, create an invite. The invite code is shown **once**. It is
   a secret: transfer it out of band (a message you trust, or by typing it), and
   do not paste it anywhere public. It is never stored and cannot be shown again.
2. On computer **B**, accept the invite. This does **not** complete pairing.
3. On computer **A**, review the request. You will see a **fingerprint** derived
   from B's real device key. Compare it with the fingerprint shown on B.
4. If — and only if — the fingerprints match, type the confirmation to approve.
   If they differ, reject: a mismatch means the key you are approving is not the
   key B holds.

After approval both computers show the pair as active. If a write's result is
unclear (network dropped mid-request), the app blocks further writes and asks
you to re-read the state. That is intentional: it will not guess whether your
approval took effect.

## 4. Connect and open a project

1. Choose **Connect** on the paired computer. You will see the stages:
   _attempting a direct connection_ → _starting the remote runtime_ → _connected_.
   Only **connected** means the workbench is usable. The intermediate stages are
   not a connection, and the app does not present them as one.
2. Under **Run**, the computer has its own fixed tab.
3. Read the other computer's **authorized directories**, pick one, and browse
   it. Directory names come from the other computer; the folder structure is
   resolved there using that computer's own rules.
4. Choose a project and open it.

Each computer gets its own **isolated browser session**. Cookies and tokens from
one remote workbench are never shared with another computer, nor with Local, nor
with SSH connections. Renaming a computer does not change this isolation.

### Authorized directories

The **other** computer's user decides which folders may be listed. You cannot
add to that list from this side. Attempting to reach anywhere outside it —
including through a symlink or junction that points outward — is refused, not
quietly redirected.

## 5. Editing a computer or a server

Two different scopes, and the difference matters:

- **A computer's name** is local to this computer. Renaming is safe at any time
  and does not interrupt a live connection or reload its tab.
- **A server's configuration is shared** by every computer paired through that
  server. Changing it affects all of them, so the app refuses to save while any
  of those computers is busy. Wait until they are idle.

Saving a new server address requires the address to prove the **same** pinned
identity. If it does not, the save is refused and your stored configuration is
left exactly as it was. After a successful change, previous connection test
results no longer apply and must be re-tested.

If a save fails, your typed input is kept — you never have to retype it. If the
result is unclear, the app tells you to re-read the configuration rather than
saving twice.

## 6. Revoking access

Revoke a pair to stop a computer from connecting. The record stays visible so
you can see why it stopped working, but it can never reconnect; pair again if
you want it back.

Revoking affects only that pair. Local and every other computer keep working.
If revocation succeeds on the server but the local record cannot be deleted, the
computer is shown as revoked rather than reported as fully removed — the app
does not claim a cleanup it did not complete.

## After a disconnect: check your work

This is the part most likely to mislead, so it is worth reading carefully.

**Losing the connection tells you nothing about your task.** A remote task may
have finished, may still be running, or may have failed. The app therefore:

- distinguishes _connection lost_ from _result unknown_ from _the remote runtime
  was replaced_;
- **never** retries, resubmits or cancels anything automatically;
- **never** infers or displays a task status it did not observe;
- does **not** clear the warning just because the connection came back. A
  reconnect is not evidence about earlier work.

Verify the actual outcome in DSH on the other computer, then mark it as checked.

## Troubleshooting

Look up the step you are stuck on, not the code alphabetically. The same code
means the same thing everywhere, but what to do about it depends on the step.

### Installing / starting

| Code                                                 | Meaning and what to do                                                                                                                                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p2p.helper_platform_unsupported`                    | This OS or architecture is not supported. Only macOS and Windows on arm64/x64.                                                                                                                                                               |
| `p2p.helper_resource_unavailable`                    | No helper for this machine's architecture. **Each machine builds its own**; one built elsewhere cannot be copied in. Run `node tools/build-peer-helper.mjs --platform <darwin\|win32> --arch <arm64\|x64>`.                                  |
| `p2p.helper_integrity_failed` / `p2p.helper_invalid` | The helper does not match its manifest checksum, or is not a regular file. Delete the directory under `build/p2p/` and rebuild.                                                                                                              |
| `p2p.secure_storage_unavailable`                     | OS secure storage is unavailable, so credentials cannot be encrypted and sign-in is refused. On Windows this usually means DPAPI is restricted by the account or policy; run in a normal interactive desktop session, not a service account. |
| `p2p.settings_root_required`                         | The settings directory is not established yet. Complete Launcher first-run setup.                                                                                                                                                            |
| `p2p.not_enabled`                                    | P2P has not been explicitly enabled on this computer. Enable it under **Remote connections → P2P**.                                                                                                                                          |

### Adding a server / signing in

| Code                                                                                         | Meaning and what to do                                                                                                                             |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p2p.invalid_service_endpoint` / `p2p.invalid_signal_endpoint` / `p2p.invalid_stun_endpoint` | Address format is wrong. HTTPS must be `https:`, signalling must be `wss:`, STUN is `host:port`. Verify with `node tools/p2p-preflight.mjs` first. |
| `p2p.invalid_service_identity` / `p2p.identity_mismatch`                                     | The server presented a different identity than the pinned one. **Do not approve.** Confirm you are talking to the right server.                    |
| `p2p.server_unavailable`                                                                     | The server is unreachable or did not respond. Check all three endpoints with the preflight tool.                                                   |
| `p2p.trust_restore_rejected`                                                                 | You removed this server identity before, so it is permanently untrusted here. This is deliberate and cannot be undone.                             |
| `p2p.service_exists`                                                                         | Another server record already uses this address.                                                                                                   |
| `p2p.user_login_required` / `p2p.user_session_expired`                                       | Not signed in, or the session expired. Sign in again.                                                                                              |
| `p2p.user_already_logged_in`                                                                 | A session already exists. Sign out before switching accounts.                                                                                      |
| `p2p.user_unauthorized` / `p2p.user_scope_mismatch`                                          | The account lacks access, or the resource belongs to another account. Confirm both machines use the **same account**.                              |

### Registering this device

| Code                                                                            | Meaning and what to do                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `p2p.device_unregistered`                                                       | This machine is not registered yet. Complete registration first.                                                          |
| `p2p.enrollment_not_found` / `p2p.invalid_enrollment_grant`                     | The registration request is gone or the grant is invalid, usually a timeout or already handled. Start registration again. |
| `p2p.enrollment_state_mismatch` / `p2p.invalid_device_state`                    | State does not match your action, usually because the other side advanced it. Re-read, then act.                          |
| `p2p.enrollment_result_unconfirmed`                                             | The result is **unconfirmed** and may already have taken effect. Re-read the state rather than retrying.                  |
| `p2p.invalid_device_key` / `p2p.invalid_csr` / `p2p.invalid_device_certificate` | Device key or certificate material is invalid. This is abnormal; send the full error.                                     |

### Pairing

| Code                                                      | Meaning and what to do                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p2p.invite_invalid`                                      | The invite code is wrong, already used, or belongs to another server. Create a new invite; the code is shown only once.                                                   |
| `p2p.invite_expired` / `p2p.pair_expired`                 | The invite or pairing request expired. Start again.                                                                                                                       |
| **Fingerprints differ** / `p2p.pair_fingerprint_mismatch` | The key you are about to approve is **not** the key the other computer holds. **Reject** and start over. This is the last line of defence against a substituted identity. |
| `p2p.pair_state_mismatch`                                 | State does not match your action, usually because the other side approved or revoked. Re-read, then act.                                                                  |
| `p2p.pair_not_found`                                      | The pair is gone, usually revoked from the other side. Pair again if you still want access.                                                                               |
| `p2p.management_result_unconfirmed`                       | The write is **unconfirmed** and may have taken effect. Re-read the record; do not submit again.                                                                          |

### Connecting

| Code                                                           | Meaning and what to do                                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `direct_unavailable`                                           | No usable direct UDP path between the two networks. **There is no relay**, so this network cannot work. A limitation, not a bug.             |
| Stuck at _attempting a direct connection_                      | Signalling or STUN is unreachable. Verify WSS and STUN with the preflight tool.                                                              |
| `p2p.not_connected`                                            | The operation needs a live connection. Connect first.                                                                                        |
| `p2p.connection_busy` / `p2p.helper_busy` / `p2p.service_busy` | An operation is in flight. Wait; do not click repeatedly.                                                                                    |
| `p2p.stale_generation` / `p2p.attempt_mismatch`                | A callback from an older attempt arrived. This is **the protection working**: an old attempt cannot revive a new connection. Just reconnect. |
| Connected, but the workbench does not load                     | The remote DSH did not start. Check DSH on the other computer.                                                                               |
| `p2p.helper_unavailable` / `p2p.helper_closed`                 | The local helper process is unavailable or exited. Restart the app; if it recurs, send the logs.                                             |
| `p2p.helper_authentication_failed`                             | The helper's private channel failed authentication. Abnormal; send the full error.                                                           |

### Browsing remote directories / opening a project

| Code                           | Meaning and what to do                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `p2p.remote_roots_unavailable` | The other computer could not report its authorized directories. Check it is still connected and running.                                                          |
| `p2p.remote_root_unauthorized` | That directory is outside the other computer's authorized set.                                                                                                    |
| `p2p.remote_path_forbidden`    | The location is outside the authorized roots, including via a symlink pointing outward. **This does not mean the folder is empty.** Ask its user to authorize it. |
| `p2p.remote_path_missing`      | The location no longer exists on the other computer.                                                                                                              |
| `p2p.remote_reference_invalid` | The directory reference is invalid or stale. Go back to the root and navigate again.                                                                              |
| `p2p.remote_directory_failed`  | The other side failed to read the directory (permissions, unmounted volume). Check it there.                                                                      |

### Editing configuration

| Code                                                 | Meaning and what to do                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `p2p.service_busy`                                   | A computer sharing this server configuration is mid-operation. Wait, then save again. |
| `p2p.catalog_conflict`                               | The record changed elsewhere. Re-read, then re-apply. Your input is preserved.        |
| `p2p.service_not_found` / `p2p.connection_not_found` | The target record is gone, usually removed. Re-read the list.                         |

### Storage and internal errors

These usually indicate an environment problem or a defect. Send the full error:

`p2p.catalog_invalid`, `p2p.catalog_incomplete`, `p2p.catalog_unavailable`,
`p2p.catalog_write_failed`, `p2p.catalog_exists`, `p2p.credential_invalid`,
`p2p.credential_unavailable`, `p2p.credential_write_failed`,
`p2p.credential_create_failed`, `p2p.credential_conflict`,
`p2p.credential_cleanup_failed`, `p2p.authorization_cleanup_failed`,
`p2p.helper_cleanup_failed`, `p2p.helper_shutdown_failed`,
`p2p.helper_parent_unavailable`, `p2p.insecure_socket_directory`,
`p2p.invalid_socket`, `p2p.internal_error`, `p2p.operation_failed`,
`p2p.invalid_server_response`, `p2p.invalid_payload`, `p2p.protocol_mismatch`,
`p2p.protocol_limit`, `p2p.partition_mismatch`, `p2p.runtime_request_unscoped`,
`p2p.ipc_invalid_sender`, `p2p.request_replayed`, `p2p.request_limit`,
`p2p.invalid_peer_state`, `p2p.invalid_user_session`, `p2p.invalid_network_list`,
`p2p.network_unavailable`, `p2p.service_unconfigured`, `p2p.invalid_operation`,
`p2p.invalid_request`, `p2p.request_unavailable`, `p2p.request_timeout`,
`p2p.request_cancelled`, `p2p.attempt_not_found`, `p2p.binding_unauthorized`, `p2p.certificate_not_expired`, `p2p.config_unavailable`, `p2p.device_already_enrolled`, `p2p.device_busy`, `p2p.device_unauthorized`, `p2p.explicit_absolute_path_required`, `p2p.identity_unavailable`, `p2p.invalid_challenge`, `p2p.invalid_config`, `p2p.invalid_content_type`, `p2p.invalid_database`, `p2p.invalid_endpoint`, `p2p.invalid_enrollment`, `p2p.invalid_enrollment_token`, `p2p.invalid_generation`, `p2p.invalid_https_origin`, `p2p.invalid_identity`, `p2p.invalid_name`, `p2p.invalid_pair_action`, `p2p.invalid_signal_origin`, `p2p.invalid_stun_binding`, `p2p.invalid_user_credentials`, `p2p.invalid_wss_endpoint`, `p2p.login_failed`, `p2p.network_unauthorized`, `p2p.pair_revoked`, `p2p.pair_state_conflict`, `p2p.pairing_busy`, `p2p.pairing_expired`, `p2p.path_conflict`, `p2p.peer_offline`, `p2p.rate_limited`, `p2p.renewal_not_due`, `p2p.request_conflict`, `p2p.request_interrupted`, `p2p.sdp_binding_mismatch`, `p2p.signal_limit`, `p2p.state_already_exists`, `p2p.state_unavailable_or_insecure`, `p2p.tls_required`, `p2p.tls_unavailable`, `p2p.unknown_operation`, `p2p.unsupported_schema`, `p2p.user_conflict`, `p2p.user_not_found`, `p2p.connection_cancelled`, `p2p.credit_exhausted`, `p2p.destination_rejected`, `p2p.direct_closed`, `p2p.direct_unavailable`, `p2p.duplicate_field`, `p2p.explicit_stun_required`, `p2p.frame_scope_mismatch`, `p2p.helper_configuration_required`, `p2p.helper_listen_failed`, `p2p.helper_user_unavailable`, `p2p.identity_not_verified`, `p2p.insecure_socket`, `p2p.invalid_bootstrap`, `p2p.invalid_candidate`, `p2p.invalid_credit`, `p2p.invalid_fields`, `p2p.invalid_frame`, `p2p.invalid_json`, `p2p.invalid_pairing_code`, `p2p.invalid_result`, `p2p.invalid_sdp`, `p2p.invalid_stream_sequence`, `p2p.lease_expired`, `p2p.lease_scope_mismatch`, `p2p.listener_unavailable`, `p2p.missing_field`, `p2p.network_full`, `p2p.invalid_network_limit`, `p2p.network_revoked`, `p2p.null_field`, `p2p.pair_unauthorized`, `p2p.receive_limit`, `p2p.redirect_rejected`, `p2p.runtime_generation_mismatch`, `p2p.runtime_http_failed`, `p2p.runtime_invalid`, `p2p.runtime_invalidated`, `p2p.runtime_unavailable`, `p2p.runtime_websocket_failed`, `p2p.send_limit`, `p2p.signal_expired`, `p2p.signal_scope_mismatch`, `p2p.signal_state_conflict`, `p2p.stream_closed`, `p2p.stream_failed`, `p2p.stream_finished`, `p2p.stream_id_exhausted`, `p2p.stream_limit`, `p2p.stream_reset`, `p2p.streams_closed`, `p2p.unexpected_data_channel`, `p2p.unknown_stream`

Codes ending in `_cleanup_failed` share one meaning: **the main operation
succeeded but cleanup did not finish.** The app shows that partial success
honestly instead of claiming full completion.

### Three general rules

- **A failed test, a failed connection and a failed task are different events.**
  Diagnose them separately.
- **Anything `_unconfirmed` means read back before retrying.** Submitting again
  may apply the change twice.
- **Anything `_busy` means wait**, not click again.

## Server upgrades and backups

The coordination server holds your accounts, networks, device registrations and
pairing records. Losing it means every computer must be registered and paired
again.

Before upgrading:

1. Stop the server.
2. Back up its data directory **and** its TLS material, and verify the backup is
   readable — an unverified backup is not a backup.
3. Upgrade, then start it and confirm the HTTPS, WSS and UDP health checks
   individually. All three must pass; two out of three is a broken deployment.
4. Confirm from a desktop client that an existing pair still connects.

Downgrading after a record-format change is not supported. Restore the matching
backup instead.

Keep desktop and server versions compatible: the app checks protocol versions
and refuses to enable capabilities it cannot verify, rather than guessing.
