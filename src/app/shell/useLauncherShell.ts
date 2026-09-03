import { computed, onMounted, ref } from 'vue'
import { getBootstrapInfo } from '@/foundation/appMetadata'
import type { BootstrapErrorCode, BootstrapInfo } from '@/shared/contracts'
import { useTranslator } from '../shared/i18n/useLocale'
import type { AppRouteId } from '../shared/navigation/routes'

export type BootstrapState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly info: BootstrapInfo }
  | { readonly kind: 'blocked'; readonly code: BootstrapErrorCode }

/** The Launcher sidebar can retain labels, become an icon rail, or leave only its restore control. */
export type SidebarState = 'expanded' | 'collapsed' | 'hidden'

/** Owns shell navigation and bootstrap state; managed-directory state stays in its domain. */
export function useLauncherShell() {
  // The shell owns the chrome every route renders inside: navigation labels, the
  // topbar, the status bar, and toasts. Binding a translator to the bootstrap
  // locale left all of that in Chinese after the user switched language, so only
  // route bodies actually translated.
  const t = useTranslator()
  const activeRoute = ref<AppRouteId>('launch')
  const sidebarState = ref<SidebarState>('expanded')
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

  function advanceSidebar(): void {
    switch (sidebarState.value) {
      case 'expanded':
        sidebarState.value = 'collapsed'
        return
      case 'collapsed':
        sidebarState.value = 'hidden'
        return
      case 'hidden':
        sidebarState.value = 'expanded'
    }
  }

  onMounted(() => {
    void initialize()
  })

  return {
    activeRoute,
    bootstrap,
    bootstrapStatus,
    selectRoute,
    sidebarState,
    t,
    advanceSidebar
  }
}
