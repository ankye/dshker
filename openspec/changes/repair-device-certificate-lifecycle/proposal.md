## Why

Mac and Windows users must remain reachable after their 30-day device certificate expires. The launcher currently restores the expired certificate without renewal or recovery, so local certificate verification prevents signalling from starting even though the coordinator is reachable.

## What Changes

- Let the Go core renew a verified certificate in the coordinator's seven-day renewal window, at startup and during sustained operation.
- Recover an expired certificate using the original device key and an explicitly authorized account/network enrollment grant, never a replacement device identity.
- Preserve device identity, network bindings, pair revisions and active peer sessions; synchronize the desktop credential copy without downgrading the core's certificate.
- Return actionable typed errors for expired credentials, missing login, rejected authorization, invalid responses and interrupted persistence.
- Prove partial-success recovery with authenticated certificate readback, restart, network failures and identity-continuity tests.
- Complete the explicitly requested legacy migration: when an older desktop credential has no network ID and the core requires expiry recovery, use only that signed-in account's persisted manual network selection after fresh coordinator ownership and original-device binding verification. Missing or invalid selection is an explicit refusal, not permission to guess a network.

Target users are existing desktop and headless peers. Non-goals include disabling certificate verification, deleting or re-enrolling devices, changing DSH, substituting servers, automatically starting DSH, or deploying a coordination server without authorization.

## Capabilities

### New Capabilities

- `device-certificate-lifecycle`: secure renewal, expiry recovery, durable readback and unchanged peer ownership.

### Modified Capabilities

None.

## Impact

This repository owns the Go control-plane client/helper, Electron main-process credential synchronization, typed refusal copy and tests. The user approved the independent `dshker-server` certificate-readback protocol and local integration; its owner is `repair-dshker-device-certificate-readback` in the Go workspace OpenSpec. Existing renewal and recovery routes are reused. No Harness checkout, production credentials or installed app is modified by implementation tests. The user subsequently authorized deployment to the existing production host with port 8443 retained. Deploy only the verified server binary, preserve the current configuration, database and authority where possible, and verify health with an explicit rollback path.
