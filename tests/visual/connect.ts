/** Test-only visual entry using the existing remote/join test fixtures. */
import { createApp, h } from 'vue'
import type { DesktopApi, RemoteConnectionsState } from '@/shared/contracts'
import { P2P_BUILTIN_SERVICE, type P2PManagementApi } from '@/shared/p2p-management'
import '@/styles/tokens.css'
import '@/styles/app.css'

const serviceId = 'a'.repeat(64)
const catalog = {
  revision: 'r1',
  catalogId: 'catalog',
  services: [{ ...P2P_BUILTIN_SERVICE, serviceId, publicKey: 'pinned-key' }],
  computers: [],
  forgottenServiceIds: []
}
const state: RemoteConnectionsState = {
  connections: [
    {
      connectionId: '11111111-1111-4111-8111-111111111111',
      configRevision: 'a'.repeat(64),
      displayName: '工作室 Mac',
      host: '10.147.17.251',
      port: 22,
      user: 'a1021500932',
      status: { kind: 'disconnected' },
      testStatus: { kind: 'untested' }
    }
  ]
}
const p2p: Partial<P2PManagementApi> = {
  catalog: async () => ({ ok: true, data: catalog }),
  localDevice: async () => ({
    ok: true,
    data: { deviceId: 'local-device-a'.padEnd(32, 'a'), name: 'My mac' }
  }),
  serviceSessions: async () => ({ ok: true, data: [] }),
  registration: async () => ({
    ok: true,
    data: {
      kind: 'registered',
      serviceId,
      userId: 'user-a',
      name: 'My computer',
      publicKey: 'public-key',
      revision: 'b'.repeat(64),
      deviceId: 'device-a'
    }
  })
}
window.dshLauncher = {
  p2pManagement: p2p,
  remoteConnections: {
    getState: async () => ({ ok: true, data: state }),
    onStateChange: () => () => undefined
  }
} as unknown as DesktopApi
const domain = await import('@/app/domains/remote-connections')
domain.p2pManagement.catalog.value = catalog
domain.p2pManagement.selectedServiceId.value = serviceId
const { default: SSH } = await import('@/app/shell/components/RemoteSSHManagementPanel.vue')
const { default: Join } = await import('@/app/shell/components/P2PJoinPanel.vue')
document.body.style.overflow = 'auto'
const root = document.getElementById('review')!
root.style.cssText = 'max-width:1092px;margin:24px auto;padding:16px;display:grid;gap:16px;'
createApp({ render: () => [h(SSH), h(Join)] }).mount(root)
