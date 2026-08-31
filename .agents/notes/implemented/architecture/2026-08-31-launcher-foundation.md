# Launcher foundation uses a narrow desktop API

## Context

DSH Launcher begins as an independent Electron shell that will manage a selected DeepSeek Harness checkout and five separately registered roots. The inherited desktop template exposed placeholder VFS, sample resources, and memory-backed service paths that could be mistaken for product behavior.

## Decision

The packaged renderer is served only from `dsh-app://launcher/`. Main admits only the current application renderer, preload exposes only immutable bootstrap metadata, and the renderer presents a blocked state until later managed-root work supplies explicit registrations. The inherited VFS service now fails with the stable `service.vfs_removed` error and is absent from the reusable package public API.

## Consequences

The foundation has no path, workspace, settings, Git, Node, Harness, filesystem, process, dialog, credential, or loopback fallback. Later feature work must add named typed IPC operations and preserve distinct ownership for Harness, plugins, configuration, settings, and runtime data.

## Evidence

The foundation passed type checking, unit tests, architecture checks, source visual checks, production renderer/main builds, and the disabled-service smoke check. Electron's host binary could not be downloaded in this environment, so the renderer screenshot smoke remains pending on a host with a preseeded or downloadable Electron runtime.
