import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import type { P2PNetworkDeviceView } from '@/shared/p2p-management'
import { setLocale } from '../../shared/i18n/useLocale'
import { enUS } from '../../shared/i18n/messages.en-US'
import P2PDeviceDirectory from '../components/P2PDeviceDirectory.vue'

/** A fixed clock, so relative times are asserted rather than raced. */
const now = 1_788_000_000

function device(overrides: Partial<P2PNetworkDeviceView> = {}): P2PNetworkDeviceView {
  return {
    deviceId: 'a'.repeat(32),
    name: 'Mac Studio',
    presence: 'online',
    lastSeen: now - 10,
    version: '0.1.25',
    platform: 'darwin',
    architecture: 'arm64',
    isLocal: false,
    ...overrides
  }
}

interface DirectoryProps {
  devices: readonly P2PNetworkDeviceView[] | undefined
  maxDevices: number
  failed: boolean
  loading: boolean
  now: number
}

function render(props: Partial<DirectoryProps> = {}) {
  return mount(P2PDeviceDirectory, {
    props: { devices: [device()], maxDevices: 10, failed: false, loading: false, now, ...props }
  })
}

describe('P2P device directory', () => {
  // Copy is asserted against the dictionary rather than literals, so a wording
  // change does not fail the behaviour these tests actually cover.
  beforeEach(() => setLocale('en-US'))

  it('shows each device with its liveness, last seen and reported build', () => {
    const view = render()
    const row = view.get('[data-testid="p2p-devices-list"] li')
    expect(row.text()).toContain('Mac Studio')
    expect(row.text()).toContain('0.1.25')
    expect(row.text()).toContain('darwin/arm64')
    expect(row.get('.p2p-devices__dot').attributes('data-state')).toBe('online')
  })

  it('distinguishes never reported from reported long ago', () => {
    // 0 is not "a long time ago": the device has never told us anything.
    expect(render({ devices: [device({ lastSeen: 0 })] }).text()).toContain(
      enUS['p2p.devices.lastSeenNever']
    )
    const old = render({ devices: [device({ lastSeen: now - 3 * 86_400 })] })
    expect(old.text()).toContain('3')
    expect(old.text()).toContain(enUS['p2p.devices.lastSeenDaysSuffix'])
  })

  it('rounds last seen down to the coarsest useful unit', () => {
    // The server persists this at most once a minute, so finer precision would
    // be a lie rather than extra detail.
    expect(render({ devices: [device({ lastSeen: now - 30 })] }).text()).toContain(
      enUS['p2p.devices.lastSeenJustNow']
    )
    expect(render({ devices: [device({ lastSeen: now - 5 * 60 })] }).text()).toContain(
      enUS['p2p.devices.lastSeenMinutesSuffix']
    )
    expect(render({ devices: [device({ lastSeen: now - 3 * 3600 })] }).text()).toContain(
      enUS['p2p.devices.lastSeenHoursSuffix']
    )
  })

  it('says a build was not reported instead of hiding the device', () => {
    const view = render({
      devices: [device({ version: '', platform: '', architecture: '' })]
    })
    expect(view.text()).toContain(enUS['p2p.devices.buildUnknown'])
    expect(view.text()).toContain('Mac Studio')
  })

  it('marks the local device and sorts it first, then online before offline', () => {
    const view = render({
      devices: [
        device({ deviceId: 'b'.repeat(32), name: 'Zeta', presence: 'offline' }),
        device({ deviceId: 'c'.repeat(32), name: 'Alpha', presence: 'online' }),
        device({ deviceId: 'd'.repeat(32), name: 'Local', isLocal: true, presence: 'offline' })
      ]
    })
    const names = view.findAll('.p2p-devices__name').map((node) => node.text())
    expect(names).toEqual(['Local', 'Alpha', 'Zeta'])
    expect(view.get('.p2p-devices__badge').text()).toBe(enUS['p2p.devices.thisDevice'])
  })

  it('separates not-yet-read from an empty network', () => {
    // Claiming a network is empty before looking would be a different fact.
    const unread = render({ devices: undefined })
    expect(unread.find('[data-testid="p2p-devices-empty"]').exists()).toBe(false)
    expect(unread.find('[data-testid="p2p-devices-list"]').exists()).toBe(false)
    const empty = render({ devices: [] })
    expect(empty.get('[data-testid="p2p-devices-empty"]').text()).toBe(enUS['p2p.devices.empty'])
  })

  it('surfaces a failed read instead of showing an empty list', () => {
    const view = render({ devices: undefined, failed: true })
    expect(view.get('[data-testid="p2p-devices-error"]').text()).toBe(
      enUS['p2p.devices.readFailed']
    )
    expect(view.find('[data-testid="p2p-devices-empty"]').exists()).toBe(false)
  })

  it('reports the count against the capacity the server confirmed', () => {
    const view = render({
      devices: [device(), device({ deviceId: 'e'.repeat(32), name: 'Second' })],
      maxDevices: 30
    })
    const summary = view.get('[data-testid="p2p-devices-summary"]').text()
    expect(summary).toContain('2')
    expect(summary).toContain('30')
  })
})
