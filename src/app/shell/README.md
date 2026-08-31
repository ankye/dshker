# Launcher shell

The shell owns application-level navigation and the explicit bootstrap-blocked
state. It does not own root registration, Git, toolchain, subprocess, or
Harness client workflows. Those capabilities are added by domain modules and
their typed main-process operations.

Do not add sample rows, in-memory settings, generated workspaces, or a
successful-state substitute when the registry is unavailable.
