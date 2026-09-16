# The pin is keyed by the id a connection names

## What happened

0.1.48 could not connect to any paired computer. Every attempt was refused with
`p2p.pair_unauthorized`, and because that code is one auto-reconnect treats as
final, each computer was written off after a single attempt until the machine's
own network changed. Nothing on screen said why: the refusal was recorded on the
connection store, and the Run page only ever read that store when the Remote
connections page had been opened.

## Why

The paired-computer list moved from the shell into the core in 0.1.48. The shell's
builder (`pinIdentity`, deleted with the move) rewrote `pair.pairId` before handing
a pair to the helper:

```ts
// The coordinator keys a connection attempt by the TARGET DEVICE ID, and the
// helper keys its pin map by this same value, so the id carried here is the
// connection id — not the pairs-table row id.
pairId: connectionId,
```

The Go port passed the coordinator's identity through unchanged, so the pin landed
under the pairs-table row id while `Manager.Connect` looked up the remote device id
the shell sends. The lookup could never match — for either direction, since an
inbound attempt is resolved through the same pin map — and with no pins at all the
whole P2P path was dead. Only the transport underneath it was still fine.

The rewrite was invisible in the type: `PairIdentity` carries five ids and only one
of them is the one every lookup uses. The id the catalog records, the id in the pin
map, and the id in the request are one value, and nothing in the code said so.

## The fix

- `pinnedIdentity` rewrites the pair's id to the remote device id before it reaches
  `Manager.Pin`, with the rule written down where the rewrite happens.
- `TestPinnedIdentityUsesTheIDTheCatalogRecords` asserts the invariant directly:
  the pin's key, the catalog row's `pairId` and the id a connection names are the
  same value. It would have failed on 0.1.48.
- The pin pass now runs inside `device.restore`, with the account lock already held
  (`refreshCatalogLocked`), so the pins exist before the shell is told the machine
  is online. The old shape fired the same pass from a goroutine, which left a
  window in which the machine was online and could not accept a connection.
- Auto-reconnect clears its terminal refusals when the core announces a new catalog
  revision — the moment the core has re-derived the pairs and their pins — so a
  refusal caused by a pin that did not exist yet is not permanent.
- A failed pass logs `[p2p] catalog refresh … failed: …`; the refusal inside it used
  to be dropped, and its only symptom was "this computer will not connect".

## What this does not fix

Connections now get as far as the runtime handshake and are refused with
`p2p.runtime_request_unscoped`: the shell that receives `runtime.connect` has no
`starting-runtime` stage recorded for the pair. Both machines must run this build
before that can be judged — the peer is still on 0.1.48, whose core cannot pin at
all — so the end-to-end reconnect path stays unverified until then.
