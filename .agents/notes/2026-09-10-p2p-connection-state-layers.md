# Connection state has two layers, and only one of them is the network

## What changed

Remote connection state is now tracked in two explicit layers with one shared
source each, instead of being derived independently by every surface.

- **Network session** (`p2pNetwork`): this computer's session with a coordinator.
  Tracked in main, exposed as `serviceSessions`, pushed on change, swept every
  60 seconds, and shown in the status bar on every route.
- **Pair connection** (`p2pConnections`): whether one specific remote workbench
  is reachable. Now projected onto runtime tabs for peers as well as SSH.

## The defect this started from

A user reported that the device directory listed their computer as online while
the Connect tab said offline. Both were reading real data; they were answering
different questions.

The Connect tab derived network status from pair stages:

```ts
peers?.some((peer) => peer.serviceId === id && peer.stage === 'ready')
```

Reaching `ready` requires a paired computer. With one enrolled machine and zero
pairs that stage is unreachable, so the card reported offline for a state the
user could not act on, next to a "leave network" button that describes the
machine's relationship to the server. The device directory used
coordinator-reported presence and was correct.

## Why the first fix was reverted

The first attempt (`1d3bc04`, reverted by `0596f53`) kept the strict definition
and added an "unpaired" state so the single-computer case stopped saying offline.
That corrected a symptom on the wrong layer: the card's label asks about the
network, and paired devices have nothing to do with reaching a server. Keeping it
would have left the real defect in place behind more plausible wording.

The user rejected it on exactly that ground, twice. The second rejection —
"network state should be global, otherwise how does the browser tab work" —
identified the actual scope: three surfaces each computed connection state
their own way, so disagreement was structural.

## Three surfaces, three algorithms

| Surface          | How it decided                                              |
| ---------------- | ----------------------------------------------------------- |
| Device directory | coordinator-reported `presence`                             |
| Connect tab      | scanned `peers` for a `ready` stage                         |
| Runtime tabs     | SSH carried `connection.status`; peer hardcoded `undefined` |

`goOnline()` already computed the per-service session, including the refusal that
explains a down session, and discarded both. The information existed; nothing
kept it.

## Ordering, not just staleness

Sessions are established after the window is created, deliberately, so an
unreachable coordinator cannot delay startup. The renderer's first read therefore
observes "not attempted yet" legitimately — and before the push existed, nothing
corrected it. The status stayed offline for the rest of the run.

The read also lived in the Connect panel's `onMounted`, so the status bar showed
"unknown" until that tab was visited. Both are properties of where the read
lived, not of the network.

## Maintenance was missing entirely

A session was attempted once and never re-checked. Once lost it was never
retried, so a coordinator that was briefly unreachable, a network change, or a
wake from sleep left the launcher offline until restart — while the offline hint
shown to users promises that starting the app is what brings a computer online.

A sweep now retries only services that are not online. A runtime loss also marks
its sessions offline: the recorded state previously stayed `online` after the
helper became unavailable, asserting reach the computer no longer had.

## Distinctions kept rather than collapsed

- **Unread is not offline.** Both layers return `undefined` before a read, so no
  surface claims a negative it has not observed.
- **A revoked pair is disconnected, not failed.** Losing authorization is not a
  connection fault.
- **A refused read is not evidence.** The last successful read stands.

## Peer tab status carries no address

`RemoteConnectionStatus.ready` holds a `url`. A peer tab must never hold the DSH
entry point, which stays in main and is handed to the guest there. Rather than
reuse that type or special-case peers, both sources project to an address-free
`RuntimeTabStatus`, and a test asserts a ready peer status contains no address.

## The subscription is not an operation

Registering the session listener on `PeerManagementOwner` failed 79 admission
tests at once. Those tests assert that no owner member is touched until a request
is admitted, and a listener registered at startup violates it. The subscription is
passed to `registerPeerManagementIpc` as a separate parameter; a new test pins the
separation and that the push reaches the window without dispatching an operation.

## A gap this closed in its own earlier commit

Moving the Connect tab off pair stages left nothing in the app reading
`p2pConnections`. Its polling only continues an in-flight attempt, so peer tab
indicators would have stayed unread forever. The shell now seeds that read at
start alongside the network session. Without the second layer this gap would have
shipped silently.

## Test flakiness I introduced

Two maintenance tests used fake timers and failed roughly one run in four. One
sweep awaits catalog inspection, runtime readiness, activation and credential
restore, so advancing the clock one tick does not mean the sweep finished. They
now wait for the observable result.

## OpenSpec

This advances 5.4 (presence, connection state, stages) on the renderer side and
supplies the state 4.4 requires. Neither is checked off: two-machine acceptance
has not been carried out, and a single-computer run cannot demonstrate a pair
reaching `ready`.

## Handover

Interface details for the surface work are in
`docs/handover-p2p-connection-state.md`. The layering principle is recorded in
`docs/architecture.md` so the next change does not re-derive per surface.
