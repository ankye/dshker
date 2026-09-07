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

| What you see                               | What it means                                                          | What to do                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `direct_unavailable`                       | No direct UDP path exists between the two networks.                    | Try a different network. There is no relay; this is a limitation, not a bug. |
| `p2p.identity_mismatch`                    | The server or peer presented a different identity than the pinned one. | Do not approve. Confirm you are talking to the right server/computer.        |
| Fingerprints differ during pairing         | The key being approved is not the key the other computer holds.        | Reject the request and start over.                                           |
| `p2p.service_busy`                         | A computer sharing this server configuration is mid-operation.         | Wait until it is idle, then save again.                                      |
| `p2p.catalog_conflict`                     | The record changed elsewhere while you were editing.                   | Re-read the record, then re-apply your change.                               |
| `p2p.remote_path_forbidden`                | The location is outside the other computer's authorized directories.   | Ask its user to authorize the folder. It is not an empty folder.             |
| `p2p.remote_roots_unavailable`             | The other computer could not report its authorized directories.        | Check that it is still connected and its app is running.                     |
| `p2p.pair_not_found`                       | The pair is no longer active, usually revoked from the other side.     | Pair again if you still want access.                                         |
| `p2p.not_enabled`                          | P2P has not been explicitly enabled on this computer.                  | Enable it in **Remote connections → P2P**.                                   |
| Stuck at _attempting a direct connection_  | Signalling or STUN is not reachable.                                   | Verify the WSS and STUN addresses and that the server's UDP port is open.    |
| Connected, but the workbench does not load | The remote DSH did not start.                                          | Check DSH on the other computer.                                             |

A failed **test** and a failed **connection** are different events, and so are a
failed connection and a failed task. The app keeps them separate; when
diagnosing, do too.

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
