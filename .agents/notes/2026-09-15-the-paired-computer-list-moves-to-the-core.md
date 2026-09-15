# The paired-computer list moves to the core too

Date: 2026-09-15

## What was wrong

The network device directory became the core's in 0.1.42, and the same reasoning
was never applied to the other list the P2P screens render: which computers this
machine may connect to. `PeerMemberSync` rebuilt it inside the shell, triggered by
a _page_ — the Run tab's add menu read the coordinator's pairings on every open,
pinned them into the peer session, and rewrote the catalog. Two consequences, both
reported by users in the directory's case:

- a computer paired elsewhere appeared in the list only the next time the menu was
  opened, and a list nobody opened could stay wrong indefinitely;
- the catalog was written from a page's read, so two windows could disagree about
  it and the record had an owner per call rather than one owner.

It was also the last "a page triggers a coordinator read" path in this area.

## What moved

`networking/internal/helper/members.go` reads the pairs (`pairs`, then each pair's
`identity`), pins every active pair into the peer session, and records the result
into the catalog the core already owns — on the same 30-second maintenance interval
as the directory, and immediately after any operation that can change a pairing
(`catalogChangesOn`: joining or leaving a network, binding or unbinding a device,
creating or deleting a network or a pair, approving, revoking, inviting, adopting).

The recording rules are the shell's, not new ones, and they are the reason this
moved rather than being rewritten:

- only an active pair with a positive revision is admitted;
- a pair whose local side is not this machine's key is not this machine's
  authorization;
- a row naming this machine as its own peer is dropped wherever it appears,
  because it would otherwise survive every rewrite;
- one row per peer, so a second pair over another network does not create a second
  tab;
- a row the coordinator no longer carries is recorded as **revoked**, not dropped,
  because dropping an active computer is what the catalog's transition guard
  refuses — and a connection authorized again is retired in a commit of its own
  before it is recorded, because the same guard refuses reviving a revoked row in
  one step. Getting this wrong is what used to wedge two machines on each other's
  stale identity.

Whenever the record changes the core sends `catalog.changed` with
`{serviceId, revision}`, the revision being the catalog's own — the store's commit
is a no-op for an identical record, so a pass that found the same pairs announces
nothing and no list re-renders.

## What this cost the shell

`member-sync.ts`, `member-catalog.ts` and their tests are gone, along with
`#refreshMembers`, `PeerPairing.members`, `PeerPairing.pin`, the pair-record helpers
that only they used, and `PeerPairing.list` — which had already lost every caller.
`pairs()` now inspects the catalog and filters it: no session, no coordinator call,
no runtime start. The shell still calls `pairs.pin` when a pairing is approved,
because that is a command rather than bookkeeping.

The renderer gets the change as a push (`P2P_CATALOG_CHANGED_CHANNEL`,
`onCatalogChange`), mirroring the directory's, and the pairing domain subscribes for
the service it is showing.

## Deliberate

The subscription is single-slot, like the enrollment domain's: one component owns
it (the Run tab's add menu), and a second owner would let one unmount cancel the
other's. If a second consumer appears, that is the point to make the subscription a
counted or shared one rather than to let two components fight over it.

The Go tests cover the rules and the sequencing against a **real** catalog store, so
the layout's transition guard is genuinely exercised; the read loop itself (pairs
and identity through the coordinator client) is covered by the client's own tests
and is thin here.
