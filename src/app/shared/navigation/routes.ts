export const APPLICATION_ROUTES = [
  { id: 'launch', labelKey: 'nav.launch', icon: 'play' },
  { id: 'advanced', labelKey: 'nav.advanced', icon: 'sliders' },
  { id: 'versions', labelKey: 'nav.versions', icon: 'layers' },
  { id: 'controller', labelKey: 'nav.controller', icon: 'terminal' },
  { id: 'usage', labelKey: 'nav.usage', icon: 'gauge' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'gear' },
  { id: 'runtime', labelKey: 'nav.runtime', icon: 'zap' }
] as const

export type AppRouteId = (typeof APPLICATION_ROUTES)[number]['id']

export type NavIconId = (typeof APPLICATION_ROUTES)[number]['icon']

/** Returns the exact registered application navigation record, if present. */
export function findApplicationRoute(routeId: AppRouteId) {
  return APPLICATION_ROUTES.find((route) => route.id === routeId)
}
