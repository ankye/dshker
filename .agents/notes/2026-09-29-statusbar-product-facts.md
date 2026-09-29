# Status bar product facts

## Change

The trailing status group now shows four current product facts: DSHKer version,
the selected DSH tag or branch/short commit, DSH runtime state, and selected
coordinator session state. Internal Desktop API and application-scope diagnostics
were removed from the footer. All four facts remain visible while the existing
operation-progress control is active; it occupies the flexible space between the
left controls and trailing facts.

## State and presentation rules

- Launcher version comes from the compiled `APP_METADATA` value.
- DSH uses a tag only when the active commit exactly matches that tag; otherwise
  it shows the known branch and short commit. The title and accessible name keep
  the full commit.
- Runtime state comes from `LauncherHarnessState.launch.kind`; unread is shown
  as `Reading`, not as stopped.
- Network status continues to come from the selected coordinator session. An
  unread session stays unknown, distinct from confirmed offline.
- Running/online use success color, starting uses accent, failed uses danger,
  and stopped/unread values stay muted.

No IPC, persistence, runtime, or network behavior changed. The active OpenSpec
records this presentation requirement in task 11.3. Focused statusbar tests and
the shell footer assertion pass; the full release-readiness gate is being rerun.
