# Task 6.2 — the headless host that hosted nothing

Date: 2026-09-14
Change: `go-owned-headless-core` (P6, task 6.2)

## What an L3 run found that no test did

Driving the product's own headless path on Windows — `dshkerd serve` plus
`dshkerd dsh start` — crashed the child every time:

    Error: dsh: failed to read overlay <state>\state.json\no-overlay.yml: ENOENT

`runDshStart` names `no-overlay.yml` in the state directory as the child's
`--patch` overlay when the caller names none, and **nothing ever created it**. DSH
treats `--patch` as a required file — a missing one is a misconfiguration, not "no
overlay" — so a headless host started, reported `starting`, then `failed` with
`runtime.child_crashed`, and `proxy` answered `p2p.runtime_unavailable` forever.

The desktop path never saw this: the shell writes its own profile overlay
(`cordis.patch.yml`, contents `[]`) and passes that path. The integration suite
never saw it either, because its fake launcher ignores the overlay argument — which
is exactly the substitution the suite is allowed to make, and exactly why an L3 run
was worth doing.

## The fix

The command that names the file creates it, with the same empty overlay the shell
writes: `[]\n`, `0o600`, only when the file is absent. A `--patch` the caller named
is the caller's file and is left alone — a missing one still fails, because that is a
misconfiguration and not something to invent.

`TestHeadlessCLIOperatesTheCore` now pins the rule where the product crosses it: after
`dsh start`, the overlay the command named must exist and be empty. The test fails if
a headless start leaves no overlay behind.

## Result on the machine that found it

With the fix, the same two commands on Windows produce a headless host that really
serves: private channel `serving=true`, launch `launch-67de3a12…` running in
the Harness checkout, `status` and `proxy` both answering
`http://127.0.0.1:3080/?token=…` from the DSH web the core supervises. No GUI or
Electron process ran on that machine; every step was CLI. Evidence:
`.run/cross-machine/host-product-path.txt`.

## Still open

The peer half of L3 (the macOS Electron launcher opening that workbench through the
deployed coordinator) and task 7.5's packaged three-way pass. The boundary the runs
are classified by is `networking/docs/verification-boundary.md`.
