import { computed, onMounted, ref } from 'vue'
import { getBootstrapInfo } from '@/foundation/appMetadata'
import type { BootstrapErrorCode, BootstrapInfo } from '@/shared/contracts'
import { useTranslator } from '../shared/i18n/useLocale'
import type { AppRouteId } from '../shared/navigation/routes'

export type BootstrapState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly info: BootstrapInfo }
  | { readonly kind: 'blocked'; readonly code: BootstrapErrorCode }

/** Owns shell navigation and bootstrap state; managed-directory state stays in its domain. */
export function useLauncherShell() {
  // The shell owns the chrome every route renders inside: navigation labels, the
  // topbar, the status bar, and toasts. Binding a translator to the bootstrap
  // locale left all of that in Chinese after the user switched language, so only
  // route bodies actually translated.
  const t = useTranslator()
  const activeRoute = ref<AppRouteId>('launch')
  const sidebarCollapsed = ref(false)
  const bootstrap = ref<BootstrapState>({ kind: 'loading' })

  const bootstrapStatus = computed(() => {
    if (bootstrap.value.kind === 'loading') return t('status.loading')
    if (bootstrap.value.kind === 'ready') return t('status.ready')
    return t('status.blocked')
  })

  async function initialize(): Promise<void> {
    const result = await getBootstrapInfo()
    bootstrap.value = result.ok
      ? { kind: 'ready', info: result.data }
      : { kind: 'blocked', code: result.code }
  }

  function selectRoute(route: AppRouteId): void {
    activeRoute.value = route
  }

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  onMounted(() => {
    void initialize()
  })

  return {
    activeRoute,
    bootstrap,
    bootstrapStatus,
    selectRoute,
    sidebarCollapsed,
    t,
    toggleSidebar
  }
}
