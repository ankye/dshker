# Login-driven network convergence

The Windows stale-network experience could not be fixed by asking the user to
refresh: the client did not adopt network memberships on a confirmed existing
session, and the coordinator had no post-adoption invalidation for devices that
were already online. Successful login/registration now immediately starts a
confirmed `user.current` read without delaying the visible signed-in state. A
restored persisted session uses the same boundary. The core first repairs/checks
the exact account's WSS registration, then idempotently adopts only memberships
already authorized for this device.

The independent coordinator republishes the source's current authenticated
`peer-registration` after adoption to online co-members of active shared
networks. A recipient checks its exact current account/session and refreshes its
catalog, directory and renderer network-choice view. An offline device syncs on
its next confirmed session read. Do not choose another network, change device
identity, or remove/recreate pairs when an authoritative read fails or the old
network has actually been revoked.

Validation must cover the actual Gin/WSS adoption push, authenticated client
session synchronization, callback/session fencing, renderer invalidation, and
same-session repeat behavior. These local tests are not a Mac↔Windows physical
or overnight ICE acceptance result.
