# Version-switch cleanup and profile reconciliation

## Context

Changing the managed Harness checkout between revisions left ignored build output and dependencies in place, which could make the next locked install or build fail. The native Web profile also needed its declared plugins reconciled after a core rebuild.

## Decision

Before checking out an explicitly selected revision, run `git clean -xdf` only in the already verified Launcher-owned Harness checkout. After its locked install and build complete, invoke `pnpm dsh plugin --profile web update` without an argument separator so DSH, rather than the launcher, updates its own profile.

## Consequences

Tracked Harness source and every path outside the managed checkout remain untouched. Native profile updates use the standard DSH command and report a typed plugin-operation failure when the command rejects.
