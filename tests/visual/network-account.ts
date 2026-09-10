/** Test-only review entry. Never imported or packaged by the product. */
import { createApp, h, nextTick } from 'vue'
import type { DesktopApi } from '@/shared/contracts'
import type { P2PManagementApi } from '@/shared/p2p-management'
import '@/styles/tokens.css'
import '@/styles/app.css'

// Same account/network fixtures as P2PAccountPanel.test.ts. No real account traffic.
const user = { userId: 'user-a', username: 'alice' }
const network = { networkId: 'net-a', userId: user.userId, name: 'Office', maxDevices: 10 }
const api: Partial<P2PManagementApi> = {
  currentUser: async () => ({ ok: true, data: user }),
  networks: async () => ({
    ok: true,
    data: [network, { ...network, networkId: 'net-new', name: 'Lab' }]
  }),
  networkDevices: async () => ({ ok: true, data: [] })
}
window.dshLauncher = { p2pManagement: api } as unknown as DesktopApi
const { default: Panel } = await import('@/app/shell/components/P2PAccountPanel.vue')
document.body.style.overflow = 'auto'
const root = document.getElementById('review')!
root.style.cssText = 'max-width:1092px;margin:24px auto;padding:16px;'
createApp({ render: () => h(Panel, { serviceId: 'service-a', displayName: 'Home' }) }).mount(root)
await nextTick()
