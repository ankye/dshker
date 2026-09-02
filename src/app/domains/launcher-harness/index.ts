/**
 * Public entry point for the launcher-harness domain.
 *
 * Shell components consume the domain only through this module, so the domain's
 * internal composable layout stays private to it.
 * @module
 */

export { useLauncherHarness, launchAttempts } from './useLauncherHarness'
export { usePluginCatalog } from './usePluginCatalog'
