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
    deviceId: 'a'.repeat(12),
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
  removing?: string
  canRemove?: boolean
}

function render(props: Partial<DirectoryProps> = {}) {
  return mount(P2PDeviceDirectory, {
    props: {
      devices: [device()],
      maxDevices: 10,
      failed: false,
      loading: false,
      now,
      // The ready state of this suite: a signed-in owner, nothing in flight.
      canRemove: true,
      removing: '',
      ...props
    }
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

  /**
   * A device reports presence and its build only after its session comes up, so a
   * list read once can outlive what it describes: the row said "never reported"
   * for a machine the coordinator already recorded. The list therefore has to be
   * refreshable, and the panel owns the fetch this asks for.
   */
  /**
   * A failed read must not hide a list that is already there.
   *
   * The page had fetched the devices and then lost a race with its own sibling
   * read; the failure flag replaced the rows with "the device list could not be
   * read", so a list the user could see was reported as missing. A failure only
   * replaces the list when there is nothing to show.
   */
  it('keeps showing rows beside a failed read, and only replaces an empty list with the error', () => {
    const withRows = render({ devices: [device()], failed: true })
    expect(withRows.find('[data-testid="p2p-devices-list"]').exists()).toBe(true)
    expect(withRows.get('[data-testid="p2p-devices-stale"]').text()).toBe(enUS['p2p.devices.stale'])

    const withoutRows = render({ devices: undefined, failed: true })
    expect(withoutRows.find('[data-testid="p2p-devices-list"]').exists()).toBe(false)
    expect(withoutRows.get('[data-testid="p2p-devices-error"]').text()).toBe(
      enUS['p2p.devices.readFailed']
    )
  })

  it('asks for a fresh read when the refresh control is used', async () => {
    const view = render()
    await view.get('[data-testid="p2p-devices-refresh"]').trigger('click')
    expect(view.emitted('refresh')).toHaveLength(1)
  })

  it('disables the refresh while a read is already in flight', () => {
    const view = render({ loading: true })
    expect(view.get('[data-testid="p2p-devices-refresh"]').attributes('disabled')).toBeDefined()
  })

  it('marks the local device and sorts it first, then online before offline', () => {
    const view = render({
      devices: [
        device({ deviceId: 'b'.repeat(12), name: 'Zeta', presence: 'offline' }),
        device({ deviceId: 'c'.repeat(12), name: 'Alpha', presence: 'online' }),
        device({ deviceId: 'd'.repeat(12), name: 'Local', isLocal: true, presence: 'offline' })
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
      devices: [device(), device({ deviceId: 'e'.repeat(12), name: 'Second' })],
      maxDevices: 30
    })
    const summary = view.get('[data-testid="p2p-devices-summary"]').text()
    expect(summary).toContain('2')
    expect(summary).toContain('30')
  })

  // Removal is an interface contract, not just a call: the row asks twice, says
  // it is working, and never claims an outcome the server has not confirmed.
  it('asks twice before removing a device', async () => {
    const oldId = 'b'.repeat(12)
    const view = render({ devices: [device(), device({ deviceId: oldId, name: 'Old PC' })] })
    await view.get('[data-testid="p2p-devices-remove-' + oldId + '"]').trigger('click')
    expect(view.emitted('remove')).toBeUndefined()
    expect(view.find('[data-testid="p2p-devices-confirm-' + oldId + '"]').exists()).toBe(true)
    await view.get('[data-testid="p2p-devices-confirm-' + oldId + '"]').trigger('click')
    expect(view.emitted('remove')).toEqual([[oldId]])
  })

  it('lets the owner back out of a removal', async () => {
    const oldId = 'b'.repeat(12)
    const view = render({ devices: [device({ deviceId: oldId, name: 'Old PC' })] })
    await view.get('[data-testid="p2p-devices-remove-' + oldId + '"]').trigger('click')
    await view.get('[data-testid="p2p-devices-cancel-' + oldId + '"]').trigger('click')
    expect(view.find('[data-testid="p2p-devices-confirm-' + oldId + '"]').exists()).toBe(false)
    expect(view.emitted('remove')).toBeUndefined()
  })

  it('keeps the row busy, not ready, while a removal is in flight', async () => {
    const oldId = 'b'.repeat(12)
    const view = render({ devices: [device({ deviceId: oldId })], removing: oldId })
    expect(view.get('li').attributes('aria-busy')).toBe('true')
    expect(
      view.get('[data-testid="p2p-devices-remove-' + oldId + '"]').attributes('disabled')
    ).toBeDefined()
  })

  it('says so when this machine is not in the network it is looking at', () => {
    // It still has an identity and a session, which is why it can read as online
    // elsewhere; the list must not leave the absence unexplained.
    const absent = render({ devices: [device()] })
    expect(absent.find('[data-testid="p2p-devices-local-absent"]').exists()).toBe(true)
    expect(absent.get('[data-testid="p2p-devices-local-absent"]').text()).toContain(
      enUS['p2p.devices.localAbsent'].slice(0, 20)
    )
    // A listed local device, and an empty network, are both not this case.
    expect(
      render({ devices: [device({ isLocal: true })] })
        .find('[data-testid="p2p-devices-local-absent"]')
        .exists()
    ).toBe(false)
    expect(render({ devices: [] }).find('[data-testid="p2p-devices-local-absent"]').exists()).toBe(
      false
    )
  })

  it('offers no removal for this machine, nor without a signed-in owner', () => {
    const local = render({ devices: [device({ isLocal: true })] })
    expect(local.find('[data-testid^="p2p-devices-remove-"]').exists()).toBe(false)
    const signedOut = render({ devices: [device()], canRemove: false })
    expect(signedOut.find('[data-testid^="p2p-devices-remove-"]').exists()).toBe(false)
  })
})
