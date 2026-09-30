@echo off
rem DSHKer-bundled pnpm entry (Windows): runs the Launcher's pinned pnpm
rem distribution on its standalone Node binary. The pnpm.mjs
rem package sits next to this bin directory, so %~dp0 resolves it relative to
rem the shim itself.
"%~dp0node.exe" --expose-internals "%~dp0..\pnpm\bin\pnpm.mjs" %*
