# Electron Main Process

`electron/main.ts` is the lifecycle entrypoint only. Keep app startup, smoke
mode selection, window creation, and shutdown wiring there.

Main-process responsibilities live under `electron/main/`:

- `window.ts` creates windows and loads renderer URLs.
- `titleBar.ts` owns native title bar appearance and window state helpers.
- `ipc.ts` registers all IPC groups.
- `settingsIpc.ts`, `storageIpc.ts`, `shellIpc.ts`, `diagnosticsIpc.ts`, and
  `statlogIpc.ts` own focused bridge domains.
- `smoke.ts` owns packaged and Electron smoke evidence.

Do not put product filesystem workflows directly in `electron/main.ts`. Add a
focused adapter module and expose only typed preload contracts.
