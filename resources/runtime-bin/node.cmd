@echo off
rem DSHKer-launched Node (Windows): forwards to the Launcher's own Electron
rem binary in Node mode, so shell lifecycle scripts run without a system Node.
rem Third-party code that spawns the literal node executable without a shell
rem must use the Launcher's executable directly, as the reference Desktop does.
set ELECTRON_RUN_AS_NODE=1
"%DSHKER_NODE_EXECUTABLE%" --expose-internals %*