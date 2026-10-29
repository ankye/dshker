import { computed, type Ref } from 'vue'
import { p2pAccounts, type P2PAccountSessionStatus } from '@/app/domains/remote-connections'
import type { MessageKey } from '@/app/shared/i18n/i18n'

const LABELS: Readonly<Record<P2PAccountSessionStatus, MessageKey>> = {
  unknown: 'p2p.accountSession.unknown',
  restoring: 'p2p.accountSession.restoring',
  signedIn: 'p2p.accountSession.signedIn',
  signedOut: 'p2p.accountSession.signedOut'
}

/** Shell and account pages present the same exact service's confirmed session. */
export function useP2PAccountSession(serviceId: Readonly<Ref<string | undefined>>) {
  const status = computed(() =>
    serviceId.value === undefined ? 'unknown' : p2pAccounts.sessionStatus(serviceId.value)
  )
  return {
    status,
    labelKey: computed(() => LABELS[status.value]),
    indicator: computed(() =>
      status.value === 'signedIn' ? 'online' : status.value === 'signedOut' ? 'offline' : 'unknown'
    )
  }
}
