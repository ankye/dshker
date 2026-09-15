# One challenge length, and a catalog that can be discarded

Date: 2026-09-15

## Why

Two reports, one first install: the Connect card showed
`p2p.catalog_invalid` under "reading the P2P configuration failed; this does not
mean none exists", and the Networks & Accounts page showed no server to sign in
to at all. Nothing in the product could repair either state.

## What was actually wrong

**The challenge shrank with the ids.** `controlplane.Client.Identity` minted its
challenge with `protocol.NewID()`. That was thirty-two characters until the
twelve-character id change (`be6d00e`) shortened `NewID` to six bytes, and the
shell's `verifiedService` demands exactly thirty-two (`assertAccountId(nonce,
32)`), with a comment saying a nonce is deliberately not an id. So the core
answered every `service.configure` with an identity the shell refused as
`p2p.invalid_request` before it ever reached `parsePeerService`. A first install
therefore enabled an empty catalog, failed to add the built-in server, and left
the account page with nothing to offer — with the code landing in the _catalog_
scope, so the card's copy talked about reading a configuration.

Fixed by giving the challenge its own generator on both sides: the core mints
sixteen bytes of entropy (`protocol.NewNonce`), and the coordinator accepts that
shape for `/v1/identity` while still accepting the twelve-character form that
0.1.39 mints, because a client refused there cannot ask for an identity by any
other call. The nonce is only echoed and signed, never interpreted, so accepting
two shapes costs no invariant.

**A legacy catalog is unreadable _and_ undroppable.** This machine's profile held
a record written before the twelve-character change: `catalogId` of thirty-two
hex characters, a `serviceId` of sixty-four. Every catalog operation re-validates
the stored record — inspection, commit, and even `RemoveService`, which reads
tolerantly but re-validates the file it writes — so the state is terminal: the
machine can neither use the configuration nor drop it. The product offered only a
retry, which is why the report reads "this should not happen on a first install":
for anyone upgrading from 0.1.38 or earlier, it happens on every start.

`PeerCatalog.reset()` is the missing act. It refuses a catalog that reads cleanly
(`p2p.catalog_intact`), and otherwise moves both files aside under
`.legacy-<stamp>` and creates the first empty catalog through the core. It is
deliberately not automatic: the repo's rule is that a missing or unusable record
is a typed refusal, never a silent substitution, and an unreadable record is
still the user's only copy. The Connect card shows the code, states that nothing
is deleted, and offers the discard; the domain then provisions the built-in
server so the user gets a working page rather than the same question again.

**The failure was being overwritten.** `serviceSessions` carries no `serviceId`,
so `run` fell through to the catalog scope and a successful status read replaced
the catalog's failed state. The card then rendered `catalog.value === undefined`
with no error — "nothing read yet" — which is exactly the misleading state the
"read failure is not 'not configured'" copy exists to prevent. Machine-wide reads
(`localDevice`, `connections`, `serviceSessions`) now own their scopes, mirrored
in `#scopeOf`.

## Evidence

- Falsified by reverting each part: the challenge shape (Go test asserts the
  challenge is `ValidNonce`), the discard (`catalog.test.ts` fails when `reset`
  is `enable`), the scope (`p2pManagement.test.ts` fails when the old scope rule
  is restored), and the identity chain end to end against the live coordinator.
- Verified against the real server: a fresh state's `service.configure` returns a
  thirty-two character nonce and the shell commits the service; a thirty-two
  character challenge is accepted by `https://my.ffkey.com:8443/v1/identity`, the
  twelve-character form still is, and a malformed one is refused with 400.
- Verified on this machine's real profile, through the running app over CDP: the
  Connect card showed `p2p.catalog_invalid` with the discard, clicking it left a
  fresh `catalogId` with one service and kept
  `p2p-devices.json.legacy-20260915-030655` beside it.
