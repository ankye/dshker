# A paired computer never reaches the Run picker, and cannot be connected to

## Symptom

A computer the network device directory shows as online (here
`USER-20260612LO`, win32/x64) never appeared in the Run route's
“+ / 添加远程工作台” picker. After that was fixed it appeared, but connecting
failed.

## Three defects, in the order they surfaced

### 1. The catalog was built from a source that cannot carry keys

The picker and the fixed Run tabs read `p2pManagement.catalog.computers`, which
only `PeerManagement.#syncMembers` → `#recordMembers` writes. It built each
record from the network device directory and required `device.publicKey` — but
the coordinator deliberately withholds credential material there
(`networking/internal/controlplane/types.go`):

```go
// It carries no certificate: the directory exists to identify and manage
// devices, and the coordinator deliberately withholds credential material here.
type DeviceEntry struct { DeviceID, UserID, Name, Presence, LastSeen, Version, Platform, Architecture }
```

So every member was skipped, `memberByNetwork` was empty, and the catalog record
never changed — `PeerCatalog.commit` short-circuits an unchanged record, which
is why the file kept an old mtime at 0 computers. Runtime probes confirmed it:

```
[p2p][diag] member skipped; device keys = deviceId,userId,name,presence,lastSeen,version,platform,architecture
[p2p][diag] pairs.list = 1
```

Fixed by sourcing the catalog from the pairing records, which do carry the peer's
real key: `PeerPairing.members()` resolves `pairs.list` through
`pairs.identity`, and `peerPairMember` (new, in `pair-records.ts`) keeps the
raw public key that `peerPairDevice` previously reduced to a fingerprint. The
renderer projection is unchanged, so no key reaches it.

The sync was also only run once per helper lifetime (behind the `#restored`
early return in `#readyAsDevice`); `#refreshMembers` now re-runs it on every
`pairs` read and on the session sweep for services already online.

### 2. The connection id sent to the coordinator was the wrong id

The picker reads a computer's connection stage through
`p2pConnections.find(serviceId, computer.pairId)`, so whatever the catalog calls
`pairId` is what `peer.connect` sends — and the coordinator authorizes an
attempt **by target device id**, not by pairs-table row id
(`dshker-server/internal/coordinator/sessions.go`):

```go
// Begin authorizes a connection attempt by network co-membership.
// The identifier is the TARGET DEVICE ID … The lease keeps carrying the
// identifier as PairID because the transport state machine uses it as the
// connection id.
func (sessions *Sessions) Begin(sender, targetDeviceID string, …) (Lease, error) {
    if !sessions.store.sameNetwork(sender, targetDeviceID) {
        return Lease{}, errors.New("p2p.pair_unauthorized")
    }
```

Writing the pairs-table row id into that field made the server look up a device
that does not exist, so `POST /v1/attempt` answered `403
{"code":"p2p.pair_unauthorized"}`. The pre-existing code had it right
(`pairId: device.deviceId`); the pairs rewrite above regressed it. The catalog's
`pairId` and the `pairs.pin` payload now both carry the remote device id, and
`PeerPairing.pin` takes that connection id explicitly.

Pair expiry was investigated and ruled out: `Begin` never consults
`pairs.expiresAt`, and the expired pair in the catalog was a red herring.

### 3. Every failed attempt reported one generic code

`peersession/manager.go` overwrote whatever failed with
`p2p.runtime_unavailable`:

```go
state.Stage = "failed"
state.Error = "p2p.runtime_unavailable"
```

A transport failure and a missing remote runtime therefore read identically, and
the real error was invisible from every surface. `namedRefusal(err,
transportReady)` now passes a named `p2p.*` code through, reports
`p2p.direct_unavailable` when the direct path never came up, and keeps
`p2p.runtime_unavailable` only for a genuine runtime refusal.

## Where it stands

With 1 and 2 fixed the computer appears in the picker and the coordinator accepts
the attempt. The attempt now fails at the last stage with the (now honest):

```
[peer-diag] attempt failed err=context deadline exceeded path={LocalType: RemoteType: Protocol:}
→ p2p.direct_unavailable
```

No direct UDP path was established between the two machines. The product offers no
relay by design, so this is a network/NAT condition rather than a launcher defect:
on the same LAN it should punch through, and behind a symmetric NAT or a cloud VM
it cannot.

## Migration note

A catalog written by the intermediate build of defect 2 holds a computer whose
`pairId` is the pairs-table row id. `assertPeerCatalogTransition` treats
`pairId` as an identity field, so such a record cannot be rewritten in place; it
has to be dropped and re-synced (the affected machine's record was cleared
locally). Released 0.1.27 never wrote one, because defect 1 kept the catalog
empty, so this affects only builds of this branch.
