# Close and reopen remote browser tabs

## User request and ownership

The user explicitly superseded the old non-closable remote-tab behavior. Keep
Local permanent and allow SSH/P2P guests to close and reopen from the existing
add menu. This is browser presentation lifecycle, not remote DSH Stop,
Disconnect, credential removal or saved-computer deletion.

The active OpenSpec `repair-open-workbench-reconnection` records this narrow
addition separately from its unresolved overnight/physical-network validation.
The broader recovery change remains incomplete; no installed app, account,
network, device, service or DSH process is replaced or restarted for this work.

## Implementation

- `runtimeBrowserState` owns close admission and open-tab membership. Reject
  Local/unknown IDs, clear only the closed tab's navigation, select the next
  right neighbor or previous left neighbor, and preserve background selection.
- Extract `RuntimeTabStrip.vue` from the nearly 1000-line browser panel. Selection
  and close are sibling buttons, with translated accessible labels, visible
  focus, keyboard Delete and focus restoration after Vue updates the DOM.
- Removing a tab unmounts its webview. The add menu lists it again. Ready
  connections are reused; disconnected/failed SSH records use the existing
  typed connect operation, with pending operations unavailable to repeat input.
- Keep peer entry ownership independent of guest visibility. Existing
  generation/catalog fencing remains intact. Late navigation/connect/entry
  results cannot add an opened tab ID, so a closed guest stays closed.
- Both READMEs and the unreleased bilingual changelog describe the new behavior.

## Verification and boundaries

The new test-only close suite covers local refusal, neighbor selection, active
and background DOM focus, record/remote-runtime preservation, guest unmount and
reopen, SSH ready/reconnect/pending states, late completions and generation
replacement. Existing browser and peer-entry regression tests remain required.
Source-size, types, architecture, formatting and full application tests are
reported separately from native UI and physical network acceptance.

The interactive contract records public-control workflows and requires a raw
ledger. None is fabricated from component tests. No live installed-client UI
acceptance or release claim is made without that evidence. Test/gate manifests
remain uncommitted because the user did not request a commit for this change.

Recorded results:

- New close suite: 14 passed; independent review ran the three browser suites
  together, 48 passed, and found no new actionable implementation defect.
- Full application Vitest: 1702 passed, zero failed/pending (179 files).
- Default integrity verify reran the pure diagnostic tests, full Vitest and
  915 Go race tests with zero failure/skip, then refused its integration command
  because this invocation did not provide `DSHKER_SERVER_BINARY`. It remains
  failed, not a physical recovery pass. Raw output:
  `.run/open-workbench-recovery/test-integrity-verify-tab-closing.log`.
- Native interaction verifier correctly failed for the missing raw ledger;
  static manifest/contract validation is authoring feedback only. The manifest
  adds the interactive scope without removing recovery's data-critical states,
  commands, prior physical failures or required artifacts.
- Environment, format, architecture, types, service/source-visual smoke,
  renderer/Electron source builds, strict OpenSpec, desktop app validation and
  the 74-file source-size gate passed. The extracted strip now owns the status
  CSS; the source smoke reads it explicitly and retains its original status
  assertion rather than weakening that check.
- New test-only sentinel strings were absent from both source build outputs;
  production imports/configuration retain test isolation. This is not native
  runtime-smoke, installer, signing or package acceptance.
- Original installed Mac Launcher/core/DSH PIDs and start times were unchanged.
  No commit, tag, push, publication or installed-app replacement was performed.
