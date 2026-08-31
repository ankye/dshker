## Purpose

Defines the evidence required to release the desktop launcher safely on macOS and Windows with an exact managed Harness worktree and unchanged native Harness home.

## ADDED Requirements

### Requirement: Focused verification covers the managed lifecycle

The release candidate SHALL have focused automated coverage for root registration, native-home exclusion, Launcher persistence recovery, executable identity, remote parsing, mirror/worktree containment, exact-SHA switching, plugin/configuration generation isolation, announced-URL readiness parsing, stop, crash recovery, and renderer authority restrictions.

#### Scenario: Focused verification is evaluated

- **WHEN** a release candidate is prepared
- **THEN** the release evidence identifies the focused commands and their outcomes
- **AND** a failed required check blocks release promotion

### Requirement: Integration verifies real Launcher-to-Harness startup

Release verification SHALL clone or use a managed Harness mirror, materialize an exact selected worktree, prepare its declared plugin/configuration artifacts, and launch its standard `dsh web --no-open` command through the registered Node executable. The test SHALL prove that readiness comes from the child's own announced loopback URL and that native-home behavior is normal, without setting or clearing `DSH_HOME`.

#### Scenario: End-to-end desktop smoke test succeeds

- **WHEN** the selected worktree and registered tools satisfy preflight
- **THEN** the child becomes ready only after it announces its own loopback URL
- **AND** evidence records the exact Launcher version, Harness SHA, announced URL, and executable identities

#### Scenario: End-to-end preflight is invalid

- **WHEN** any required root, tool, worktree, generation, or native-home rule is invalid
- **THEN** the smoke test blocks before ready
- **AND** it does not use another tool, ref, or home as a substitute

### Requirement: macOS and Windows enforce equivalent safety rules

The packaged macOS and Windows applications SHALL demonstrate equivalent handling of root containment, symbolic links or junctions, path aliases, explicit executable identity, Git worktrees, announced-URL readiness, child lifecycle, and native-home noninterference. Platform differences SHALL be recorded as platform evidence, not silently weakened behavior.

#### Scenario: Platform-specific validation cannot prove safety

- **WHEN** a platform cannot prove a required path, executable, child, or packaging condition
- **THEN** the platform release gate fails with that condition
- **AND** it does not waive the corresponding shared requirement

### Requirement: Packaged artifact inspection protects the trust boundary

Before release, artifact inspection SHALL confirm expected application identity, signed packaging where supported, trusted local-resource policy, no embedded unmanaged Harness checkout, no secret value, no development-only command surface, and no alternate production transport. Installation, first launch, update behavior where supported, and uninstall behavior SHALL be recorded for each supported platform.

#### Scenario: Artifact inspection finds an unexpected surface

- **WHEN** inspection finds an unexpected source checkout, secret, unsigned required artifact, development entry point, or alternate transport
- **THEN** release promotion is blocked
- **AND** the artifact is not treated as equivalent to the verified candidate

### Requirement: OpenSpec and cross-repository evidence are complete before archive

The change SHALL not be archived until strict OpenSpec validation passes, every task is complete with matching evidence, and the compatibility record identifies the accepted companion Harness commit and protocol versions. Documentation and release reports SHALL state that the Launcher owns four roots and does not manage the native Harness home.

#### Scenario: Archive gate is evaluated

- **WHEN** release evidence is assembled for archive
- **THEN** the gate verifies strict OpenSpec validation, completed tasks, macOS evidence, Windows evidence, and the exact companion commit
- **AND** it blocks archive when any required item is absent
