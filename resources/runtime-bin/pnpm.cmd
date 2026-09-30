@echo off
rem DSHKer-bundled pnpm entry (Windows): runs the Launcher's pinned pnpm
rem distribution on the Launcher's own Electron Node runtime. The pnpm.mjs
rem package sits next to this bin directory, so %~dp0 resolves it relative to
rem the shim itself.
set ELECTRON_RUN_AS_NODE=1
"%DSHKER_NODE_EXECUTABLE%" --expose-internals "%~dp0..\pnpm\bin\pnpm.mjs" %*