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
- **Peer side:** the product's desktop path (the Electron launcher). An
  independent peer implementation (`live-drive`) may stand in only when the
  subject is the host — and the run must say so.
- `live-drive` is a `-tags live` temporary driver: it must never be the host in
  L3 or L4, because it bypasses the core and therefore cannot show that the core
  owns hosting.

## L4 — packaged three-way (task 7.5)

Two machines, packaged artifacts, no source tree on either side:
desktop-hosts, desktop-to-desktop, and headless-host-to-desktop-peer.
No substitution.

## Recording a run

Every run writes `.run/<level>/README.md` naming: the two machines, the
coordinator, which components were real and which were substituted, which product
entry point ran, and the command lines. A run whose README cannot answer those is
not evidence.
