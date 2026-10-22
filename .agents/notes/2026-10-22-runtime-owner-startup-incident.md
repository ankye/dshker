# Runtime-owner startup incident: diagnosis

## Scope and status

The user reports that the GitHub-installed 0.1.95 formal Windows application
cannot read P2P configuration, disables its sign-in form and reports
`remote.persistence_failed` for SSH computers. The separate data-drive copy is a
test installation, not the formal application. This investigation made no
changes to either machine's application, accounts, pairings, roots or catalogs.
No production fix or release acceptance is claimed here.

## Verified local sequence (2026-10-21/22, UTC+08:00)

- Previous Windows launches reached `core.ready`; the last successful launch in
  the complete diagnostic log was October 21 at 20:44:32.
- The test installation was launched at 20:44:30. Its runtime-owner record was
  published at 20:44:32 and binds its absolute executable path.
- The formal Windows installation directory was created October 22 at 10:38:36.
  Its package file modification time is a build timestamp, not installation
  evidence. The user correctly identified it as the current GitHub package.
- At 10:41:09 and 10:42:34 the formal application's core emitted
  `runtime.owner_identity_mismatch`, failed its version probe and exited 1.
- The retained owner record's executable digest matches both installed helper
  binaries. State/data/catalog roots also match the formal application's
  expected roots; the absolute executable path differs. That path difference
  alone is sufficient for refusal. Inherited Home fingerprint equivalence was
  not established and is not assumed.
- The recorded owner process no longer exists. Windows has not rebooted since
  that owner was created. The record remains. No managed local DSH process was
  found during the bounded process inspection.

The test copy reused the formal user's state. This was a test-isolation mistake;
byte-identical artifacts do not isolate their runtime ownership records.

## Root cause and why the blast radius changed

Commit `fcf611fc395f636870f9d2f61ae56c2db79218ad`, first included in 0.1.91,
introduced the independent runtime owner. The relevant owner implementation,
core startup admission and shutdown code are unchanged across 0.1.93, 0.1.94
and 0.1.95. The 0.1.95 account-label fix does not explain an SSH persistence
failure before an SSH subprocess is started.

`runtime_owner.go` derives owner identity from `os.Executable()`.
`runtimeowner.Open` compares the complete configuration, executable digest,
roots digest and inherited Home fingerprint before connecting to the recorded
process. Identical binary content at another installation path is rejected.
Even at the original path, a dead owner is deliberately refused while retaining
its record; `TestOwnerDeathRefusesReplacementAndRetainsEvidence` specifies this.
Returning to the test installation is therefore not a recovery for the current
dead-owner state.

The owner-open error aborts the entire `dshkerd` composition before the core RPC
service becomes usable. This changes a failure of one P2P connection into a
failure of every Launcher feature depending on that core:

- SSH's `RemoteConnectionService.#core()` reports `remote.persistence_failed`
  when its core route is missing, before calling SSH. Its displayed text wrongly
  suggests saving the remote-computer record failed.
- The P2P catalog's advertised local fallback resolves its settings root through
  `CoreRoots`, which is also unavailable. The resulting
  `managed.core_unavailable` is mapped to `p2p.internal_error`.
- The account form treats the unread catalog/service as busy and disabled.
  Its Retry action repeats the read; it cannot reconstruct the missing core.

Earlier successful `core.ready` receipts and the current pre-RPC failures explain
why previous symptoms were narrower. They do not establish that earlier
versions were free of this latent defect.

## Real released-binary reproduction

The formal installed helper's SHA-256 is
`d9455da4c17621745c89362d4fb68b6b98f69e39ad86ed2f033836d3b1bcc0c6`.
Two byte-identical copies used only disposable data-drive roots, with no real
account or service configuration:

| Case                                                   | Actual result                                     |
| ------------------------------------------------------ | ------------------------------------------------- |
| First installation path, empty isolated roots          | `core.version` succeeds                           |
| Different path, same bytes/roots, original owner alive | Identity mismatch; core exits 1                   |
| Original path, original owner alive                    | Reattaches successfully                           |
| Normal parent-channel close                            | Core exits 0; owner record removed                |
| Different path, owner dead                             | Identity mismatch; core exits 1                   |
| Original path, owner dead                              | Owner unavailable; core exits 1; record unchanged |

Raw diagnostic receipts and the runner remain under
`.run/incident-owner-repro/`. All processes created by that diagnostic were
joined or positively identified and terminated. No diagnostic process remains.
This is fault reproduction, not repair acceptance.

## Independent SSH and Mac evidence

A read-only native OpenSSH call to the existing saved Mac computer completed in
345 ms and returned Darwin. Batch authentication and strict existing host-key
checking were used; no SSH configuration was written. The Windows remote-computer
document remains readable with its existing one entry.

Read-only Mac inspection currently finds installed Launcher 0.1.95, a live
formal core and runtime owner, a matching recorded process executable and binary
digest, and `core.ready` at October 22 10:29:25. No corresponding owner-admission
failure was found in its diagnostic log. A normal desktop core does not publish
the headless `core.json`; a CLI call without that endpoint is not evidence that
the Mac core failed. Mac account/server authorization was not independently
accepted by this diagnostic. A dead Windows endpoint can prevent connections
in both directions without proving two server outages.

## Remaining uncertainty and repair boundaries

The exact event which terminated the real Windows owner is not proven. The
limited current-session command audit found explicit-window graceful closes
before this owner was created, and no later explicit process-tree kill. Normal
channel close cleaned up correctly in the isolated reproduction.

Two concrete shutdown/update risks still require separate coverage: Electron
escalates core shutdown after one second while owner cleanup has a fifteen-second
budget; the standard installer can terminate processes whose executable path is
under its installation directory, including the helper. Neither observation is
proof that a particular operation killed this owner.

The repair must isolate test roots, prevent runtime-owner failure from disabling
unrelated catalog/account/SSH services, preserve accurate typed failures, and
provide an explicit safe recovery path for abandoned ownership. It must not
silently delete an unverified owner record, infer a running DSH from a cached
PID/URL, relax registered-root checks or switch the formal application to the
test installation. Cross-installation, upgrade and dead-owner scenarios were
missing from release acceptance; focused component tests and clean-root smoke
did not cover this actual composition.
