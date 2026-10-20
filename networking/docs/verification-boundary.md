# Verification boundary

Three levels of evidence, defined so that a run cannot be mistaken for more than
it is. The rule underneath all of them: **a component may be substituted only when
it is not the subject under test.**

## L1 — unit

Pure rules and single components. No processes, no coordinator.

## L2 — repository integration

The real `dshkerd` binary over the real private channel against the fixture
coordinator. Substitute allowed: the DSH web child (the fake launcher the runtime
tests use, and the stand-in workbench the headless-hosting test serves), the
Harness worktree, and the packaged seed's contents. Substitute forbidden: the
core's own protocol, ownership and refusal codes — those are the subject.

## L3 — cross-machine acceptance (task 6.2)

Two real machines, the deployed coordinator, the product's own entry points.

- **Host side: no substitution.** The host runs the product's headless path
  (`dshkerd serve` + `dsh start`) or the packaged launcher, and the page it
  serves is a DSH web that this run started on that machine.
- **Peer side:** the product's desktop path (the Electron launcher).
  The historical temporary `live-drive` was removed with control v2: it used
  obsolete pin/bootstrap contracts, an embedded deployment address and a
  plaintext credential state file. It is not a current test entry point.
- Current isolated physical diagnostics use `tools/workbench-recovery-live.mjs`
  and explicitly report their tier: Windows production core/serve and Mac
  production Engine plus Manager are not packaged desktop-to-desktop or full
  Mac serve acceptance. They cannot substitute for L3/L4 product-entry proof.

## L4 — packaged three-way (task 7.5)

Two machines, packaged artifacts, no source tree on either side:
desktop-hosts, desktop-to-desktop, and headless-host-to-desktop-peer.
No substitution.

## Recording a run

Every run writes `.run/<level>/README.md` naming: the two machines, the
coordinator, which components were real and which were substituted, which product
entry point ran, and the command lines. A run whose README cannot answer those is
not evidence.
