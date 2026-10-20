/** Test-only composition of the real dialog and the existing component fixtures. */
import { createApp, h } from 'vue'
import type { DesktopApi } from '@/shared/contracts'
import { apiFail, apiOk } from '@/shared/contracts'
import type { P2PComputerView, P2PNetworkChoicesView } from '@/shared/p2p-management'
import '@/styles/tokens.css'
import '@/styles/app.css'

const mode = new URLSearchParams(location.search).get('state')
if (!['required', 'pending', 'error', 'stale', 'empty', 'long'].includes(mode ?? ''))
  throw Error('Explicit UI verification state required')
const serviceId = 'a'.repeat(12),
  pairId = 'b'.repeat(12),
  networkId = 'c'.repeat(12),
  userId = 'd'.repeat(12),
  revision = 'e'.repeat(64)
let selected = false
const choices = (): P2PNetworkChoicesView => ({
  userId,
  catalogRevision: revision,
  devices: [
    {
      pairId,
      name: 'Office computer',
      selectedNetworkId: selected
        ? networkId
        : mode === 'stale' || mode === 'empty'
          ? '1'.repeat(12)
          : '',
      state: selected ? 'selected' : mode === 'stale' || mode === 'empty' ? 'stale' : 'required',
      choices:
        mode === 'empty'
          ? []
          : [
              { networkId, name: mode === 'long' ? 'Work network · '.repeat(12) : 'Work network' },
              { networkId: 'f'.repeat(12), name: 'Home network' }
            ]
    }
  ]
})
const computer: P2PComputerView = {
  connectionId: pairId,
  pairId,
  serviceId,
  networkId,
  userId,
  displayName: 'Office computer',
  localDeviceId: '2'.repeat(12),
  remoteDeviceId: pairId,
  localPublicKey: 'local-test-key',
  remotePublicKey: 'remote-test-key',
  pairRevision: 1,
  pairState: 'active'
}
window.dshLauncher = {
  p2pManagement: {
    networkChoices: async () => apiOk(choices()),
    selectNetwork: async () => {
      if (mode === 'pending') return new Promise(() => {})
      if (mode === 'error') return apiFail('p2p.request_timeout', 'test-only unknown result')
      selected = true
      return apiOk(choices())
    }
  }
} as unknown as DesktopApi
const { p2pManagement, p2pAccounts, p2pPairing, p2pConnections } =
  await import('@/app/domains/remote-connections')
p2pManagement.selectedServiceId.value = serviceId
p2pManagement.catalog.value = {
  revision,
  catalogId: '3'.repeat(12),
  services: [],
  computers: [],
  forgottenServiceIds: []
}
p2pAccounts.state(serviceId).user = { userId, username: 'test-only@example.test' }
// Explicit fixture owners replace only application capabilities in this test entry.
// They are never imported by index.html or the production app.
p2pManagement.ensureBuiltinService = async () => {}
p2pPairing.read = async () => {}
p2pManagement.readCatalog = async () => {
  if (selected && p2pManagement.catalog.value) p2pManagement.catalog.value.computers = [computer]
}
p2pConnections.connect = async () => {}
const { default: Menu } = await import('@/app/shell/components/RuntimeTabAddMenu.vue')
const root = document.getElementById('review')
if (!root) throw Error('Missing verification root')
root.style.cssText = 'position:fixed;top:40px;right:24px;'
createApp({ render: () => h(Menu) }).mount(root)
