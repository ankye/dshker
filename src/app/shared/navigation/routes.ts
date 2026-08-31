export const APPLICATION_ROUTES = [
  { id: 'launch', labelKey: 'nav.launch' },
  { id: 'advanced', labelKey: 'nav.advanced' },
  { id: 'versions', labelKey: 'nav.versions' },
  { id: 'controller', labelKey: 'nav.controller' },
  { id: 'settings', labelKey: 'nav.settings' },
  { id: 'runtime', labelKey: 'nav.runtime' }
] as const

export type AppRouteId = (typeof APPLICATION_ROUTES)[number]['id']

/** Returns the exact registered application navigation record, if present. */
export function findApplicationRoute(routeId: AppRouteId) {
  return APPLICATION_ROUTES.find((route) => route.id === routeId)
}
