# Persisted account startup single-flight — 2026-09-21

## Symptom

After a relaunch, Network & account could show the login form together with
“正在读取账户状态”, even though the user had previously signed in and the
coordinator was reachable. The state was especially easy to reproduce when the
shell startup restore and the mounted account panel read the same service at the
same time.

## Cause

`AppShell` restored P2P services while `P2PAccountPanel` and the account domain
read `currentUser`. The main service registry rejected a concurrent activation
with `p2p.service_busy`; the account registry could do the same for a concurrent
`user.current` call. A provisional login-required/refusal then cleared the
renderer identity and was not retried when the persisted session became ready.

## Fix

- Share one in-flight core attachment in `PeerRuntimeHost`, then one in-flight
  activation per service in `PeerServices`.
- Share one in-flight current-user read in `PeerAccounts` and the renderer
  `P2PAccountsDomain`.
- Retry provisional startup refusals after the service-session announcement,
  while keeping explicit logout final.
- Keep the last accepted identity through transient helper/service errors.
- Do not render the transient busy copy when the account has no accepted
  identity, avoiding a contradictory login/loading panel.

## Validation

`npm test -- --run electron/main/p2p/runtime-host.test.ts electron/main/p2p/services.test.ts electron/main/p2p/accounts.test.ts src/app/domains/remote-connections/p2pAccounts.test.ts src/app/shell/tests/P2PAccountPanel.test.ts`

Result: 5 files, 119 tests passed. The full suite also passed: 164 files, 1,464 tests.
