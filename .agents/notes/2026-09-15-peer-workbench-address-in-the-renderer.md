# The peer workbench address does reach the renderer

Date: 2026-09-15

## What prompted this

A review of the R-01 fix (a `ready` peer tab had no address, so the guest never
mounted) raised the obvious objection: `p2pManagement.entry` hands the ordinary
renderer a loopback gateway URL whose query carries a bearer token, while four
comments in the tree claimed the entry point "stays in main". Both halves were
true and the pair was inconsistent, so the decision had to be made and written
down rather than left implied.

## Why the address cannot stay in main today

A peer workbench is shown in a guest view that the renderer mounts. That view is a
`<webview>`, and Electron mounts a `<webview>` from a real `http`/`https` URL.

The alternative — a main-process scheme handler that proxies to the gateway so the
renderer only ever sees an opaque URL — does not work here: `protocol.handle`
cannot carry a WebSocket upgrade, and DSH Web needs its own WebSocket. Proxying
only the document would leave the page half-broken in a way that is worse than the
disclosure being avoided.

The token is also a bootstrap credential rather than a standing one: the gateway
sets a session cookie on the first navigation, and the guest partition holds that
cookie afterwards. The renderer holds the URL only to mount the guest.

## What the decision is

- The address is delivered by one named operation (`entry`), for one named attempt
  (`generation`), and refused when that attempt has been replaced, so a tab that
  has moved on is never handed a gateway its session no longer owns.
- It is never part of a projection: connection state, session state and the tab's
  `status` remain address-free, so nothing that only reports state can leak it.
- Isolation between peers is the guest **partition** main derives from the pinned
  service and pair identity, not the secrecy of the address. The Local tab and SSH
  remotes already hand a credential-bearing URL to the same renderer, so this is
  the established boundary in this app rather than a new one.
- Comments, the shared contract's doc comment and both P2P docs now say this
  instead of claiming the address stays in main.

## What is left open

Moving the guest itself into main (`WebContentsView`, with the renderer reporting
only a placeholder rectangle) would keep the token out of renderer memory
entirely. That changes how the Run page mounts, hides, zooms and measures every
guest, so it is recorded as OpenSpec task 4.9 in
`add-self-hosted-p2p-dsh-connections` rather than folded into a 0.1.40 fix.
