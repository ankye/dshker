# A window that vanishes should leave a reason

Date: 2026-09-15

## What prompted it

A report that the app "just closed" when the Remote connections tab was opened. The
machine had nothing to say about it: the Application event log held no error, no
hang and no crash report, there was no crash dump under the app's directories, and
the launcher's own log stopped mid-sentence at the moment the window went away.

The evidence, in the end, pointed at a forced stop of a development instance during
a packaging run rather than at a crash — which is precisely why the trace was
missing. A killed process is not a crash, so no crash reporter records it, and the
application's own main process had no handler for a renderer that dies, a child
process that exits, or an uncaught exception. Every one of those looks the same
from the user's side: the window is gone, and the only evidence is their word.

## What was added

`electron/main/main-faults.ts`, installed in `electron/main.ts` as soon as the
launcher root exists, writes one line per unexpected death to
`logs/main-faults.log`:

- `render-process-gone` — the reason, the exit code, and the page the renderer was
  showing (or its type, if it never navigated).
- `child-process-gone` — the process type and name, the reason and the exit code.
- `uncaughtException` — recorded, then `app.exit(1)`, which is the exit the default
  Node behaviour would have produced. Adding a listener would otherwise have
  _changed_ the behaviour into "keep running in an unknown state".
- `unhandledRejection` — recorded and nothing more; a rejection is usually
  recoverable and the process keeps going.

The module takes its event sources and its sink as parameters, so the four
registrations and the three line formats are unit-tested without Electron: a fake
`EventEmitter` emits each event and the test asserts the recorded line and whether
the process exited.

## What it deliberately is not

It is not crash reporting. A normal exit, a window closed by the user, and a
process stopped from the launcher write nothing — including the case that started
this note, where the process was killed on purpose. An empty `main-faults.log` is
the normal state, and the documentation says so, because a file that is empty in
the healthy case is only useful if the reader knows that.

The next time a report says "it closed by itself", the answer is one line in that
file. If the file is empty and no window was stopped deliberately, the death was
not one Electron reports — which is itself a useful finding, and the reason the
"empty is normal" rule is written down rather than implied.
