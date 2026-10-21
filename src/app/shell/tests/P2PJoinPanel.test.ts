import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import {
  P2P_BUILTIN_SERVICE,
  type P2PCatalogView,
  type P2PManagementApi,
  type P2PRegistrationView,
  type P2PServiceSessionView
} from '@/shared/p2p-management'

const serviceId = 'a'.repeat(12)
const service = {
  serviceId,
  publicKey: 'pinned-key',
  displayName: P2P_BUILTIN_SERVICE.displayName,
  httpsOrigin: P2P_BUILTIN_SERVICE.httpsOrigin,
  wssUrl: P2P_BUILTIN_SERVICE.wssUrl,
  stunAddress: P2P_BUILTIN_SERVICE.stunAddress
}
const saved: P2PCatalogView = {
  revision: 'r1',
  catalogId: 'catalog',
  services: [service],
  computers: [],
  forgottenServiceIds: []
}
const registered: P2PRegistrationView = {
  kind: 'registered',
  serviceId,
  userId: 'user-a',
  name: 'My computer',
  publicKey: 'public-key',
  revision: 'b'.repeat(64),
  deviceId: 'device-a',
  networkId: 'network-a'
}
const pending: P2PRegistrationView = {
  kind: 'pending',
  serviceId,
  userId: 'user-a',
  name: 'My computer',
  publicKey: 'public-key',
  revision: 'a'.repeat(64),
  requestId: 'original-request',
  networkId: 'network-a'
}
let previous: DesktopApi | undefined
let wrapper: VueWrapper | undefined

beforeEach(() => {
  previous = window.dshLauncher
  vi.resetModules()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  window.dshLauncher = previous
})

/** Mounts with the built-in service catalog and selection pre-set. */
/**
 * The transport session supplies connection diagnostics. Login status is read
 * from the account domain and is never inferred from this transport snapshot.
 */
function sessionReader(sessions: P2PServiceSessionView[] = []) {
  return vi
    .fn<P2PManagementApi['serviceSessions']>()
    .mockResolvedValue({ ok: true, data: sessions })
}

/** One projected directory row, so a case only states which machine it carries. */
function boundDevice(deviceId: string) {
  return {
    deviceId,
    name: 'This machine',
    presence: 'online' as const,
    lastSeen: 0,
    version: '',
    platform: '',
    architecture: '',
    isLocal: true
  }
}

/** A known directory, empty unless a case names the machines it carries. */
function directoryReader(deviceIds: readonly string[] = []) {
  return vi.fn<P2PManagementApi['directory']>().mockResolvedValue({
    ok: true,
    data: {
      known: true,
      revision: 1,
      fetchedAt: 1_789_445_714,
      networks: [],
      devices: deviceIds.map(boundDevice)
    }
  })
}

async function render(api: Partial<P2PManagementApi>) {
  const localDevice = vi.fn<P2PManagementApi['localDevice']>().mockResolvedValue({
    ok: true,
    data: { deviceId: 'local-device-a'.padEnd(32, 'a'), name: 'My mac' }
  })
  const directory = directoryReader()
  window.dshLauncher = {
    p2pManagement: { serviceSessions: sessionReader(), localDevice, directory, ...api }
  } as unknown as DesktopApi
  const domain = await import('@/app/domains/remote-connections')
  domain.p2pManagement.catalog.value = saved
  domain.p2pManagement.selectedServiceId.value = serviceId
  const component = (await import('../components/P2PJoinPanel.vue')).default
  wrapper = mount(component)
  await flushPromises()
  return wrapper
}

describe('P2P 「我的网络」 card', () => {
  it('provisions the built-in official server automatically on mount', async () => {
    const catalog = vi.fn<P2PManagementApi['catalog']>().mockResolvedValue({
      ok: true,
      data: saved
    })
    const localDevice = vi.fn<P2PManagementApi['localDevice']>().mockResolvedValue({
      ok: true,
      data: { deviceId: 'local-device-a'.padEnd(32, 'a'), name: 'My mac' }
    })
    window.dshLauncher = {
      p2pManagement: { catalog, localDevice, serviceSessions: sessionReader() }
    } as unknown as DesktopApi
    const domain = await import('@/app/domains/remote-connections')
    const component = (await import('../components/P2PJoinPanel.vue')).default
    wrapper = mount(component)
    await flushPromises()
    expect(catalog).toHaveBeenCalled()
    expect(domain.p2pManagement.selectedServiceId.value).toBe(serviceId)
    expect(domain.p2pManagement.builtinProvisioned.value).toBe(true)
    expect(wrapper.find('[data-testid="p2p-join-form"]').exists()).toBe(true)
  })

  it('always shows the device name and identifier, with no endpoint inputs', async () => {
    const ui = await render({})
    const info = ui.get('[data-testid="p2p-device-info"]')
    expect(info.text()).toContain('设备名称')
    // The machine's own id is shown in the open, next to its name, with a copy
    // control: it is the value an owner reads out loud or pastes elsewhere.
    expect(info.text()).toContain('设备标识')
    expect(info.text()).toContain('local-device-a')
    expect(info.find('.copy-path-button').exists()).toBe(true)
    expect(ui.find('.connect-device-details').exists()).toBe(false)
    expect(ui.find('.connect-membership-details').exists()).toBe(false)
    expect(ui.find('input[name]').exists()).toBe(false)
    expect(ui.findAll('input')).toHaveLength(1)
    expect((ui.get('[data-testid="p2p-join-network"]').element as HTMLInputElement).type).toBe(
      'text'
    )
  })

  it('flows not-joined -> pending -> not-joined again after a confirmed cancel', async () => {
    const joinNetwork = vi.fn<P2PManagementApi['joinNetwork']>().mockResolvedValue({
      ok: true,
      data: pending
    })
    const registration = vi.fn<P2PManagementApi['registration']>().mockResolvedValue({
      ok: false,
      code: 'p2p.credential_unavailable',
      message: 'nothing stored'
    })
    const ui = await render({ joinNetwork, registration })
    // Not joined: join form with a single network ID input.
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(true)
    await ui.get('[data-testid="p2p-join-network"]').setValue('network-a')
    await ui.get('[data-testid="p2p-join-form"]').trigger('submit')
    await flushPromises()
    expect(joinNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId, networkId: 'network-a' })
    )
    // Pending: input greyed out, cancel button, waiting-for-approval status.
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-pending-state"]').exists()).toBe(true)
    const disabled = ui.get('[data-testid="p2p-pending-network"]')
    expect((disabled.element as HTMLInputElement).disabled).toBe(true)
    expect(ui.get('[data-testid="p2p-pending-status"]').text()).toContain('等待审批')
    // Cancel with a readback that proves no registration clears the pending draft.
    await ui.get('[data-testid="p2p-cancel-request"]').trigger('click')
    await flushPromises()
    expect(ui.find('[data-testid="p2p-pending-state"]').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(true)
  })

  it('keeps the pending state when the readback still reports a registration', async () => {
    const joinNetwork = vi.fn<P2PManagementApi['joinNetwork']>()
    const registration = vi.fn<P2PManagementApi['registration']>().mockResolvedValue({
      ok: true,
      data: pending
    })
    const ui = await render({ joinNetwork, registration })
    // The mount readback reports a pending registration: the card starts pending.
    expect(ui.find('[data-testid="p2p-pending-state"]').exists()).toBe(true)
    await ui.get('[data-testid="p2p-cancel-request"]').trigger('click')
    await flushPromises()
    // The readback still holds the pending enrollment, so nothing is cleared.
    expect(ui.find('[data-testid="p2p-pending-state"]').exists()).toBe(true)
    expect(joinNetwork).not.toHaveBeenCalled()
  })

  it('shows the registered card with no input, unconfirmed login and a leave action', async () => {
    const ui = await render({})
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pEnrollment.state(serviceId).registration = registered
    domain.p2pEnrollment.state(serviceId).joinNetworkIdDraft = 'network-a'
    // A cached username is useful context, but an unread current session cannot
    // authorize account-only actions.
    domain.p2pAccounts.state(serviceId).user = { userId: 'user-a', username: 'cached-owner' }
    await flushPromises()
    const info = ui.get('[data-testid="p2p-device-info"]')
    expect(info.text()).toContain('My computer')
    expect(ui.get('[data-testid="p2p-joined-network"]').text()).toContain('network-a')
    expect(ui.get('[data-testid="p2p-joined-network"]').find('.copy-path-button').exists()).toBe(
      true
    )
    expect(ui.find('.connect-device-details').exists()).toBe(false)
    expect(ui.find('.connect-membership-details').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-pending-state"]').exists()).toBe(false)
    expect(ui.get('[data-testid="p2p-network-status"]').text()).toContain('登录状态待确认')
    expect(ui.find('[data-testid="p2p-leave-network"]').exists()).toBe(true)
    expect(ui.get('[data-testid="p2p-leave-network"]').attributes('disabled')).toBeDefined()
  })

  it('recovers one legacy joined network id from the authoritative local directory', async () => {
    const ui = await render({
      directory: directoryReader(['device-a'])
    })
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pManagement.catalog.value = {
      ...saved,
      computers: [
        {
          connectionId: 'connection-a',
          serviceId,
          displayName: 'This machine',
          pairId: 'pair-a',
          networkId: 'network-a',
          localDeviceId: 'device-a',
          remoteDeviceId: 'remote-a',
          userId: 'user-a',
          localPublicKey: 'local-key',
          remotePublicKey: 'remote-key',
          pairRevision: 1,
          pairState: 'active'
        }
      ]
    }
    domain.p2pEnrollment.state(serviceId).registration = {
      ...registered,
      networkId: undefined
    }
    await flushPromises()
    expect(ui.get('[data-testid="p2p-joined-network"]').text()).toContain('network-a')
  })

  it('requires confirmed login even when the coordinator transport is online without peers', async () => {
    const ui = await render({
      serviceSessions: sessionReader([{ serviceId, state: 'online', code: '' }]),
      currentUser: async () => ({ ok: true, data: { userId: 'user-a', username: 'owner' } }),
      networks: async () => ({ ok: true, data: [] })
    })
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pEnrollment.state(serviceId).registration = registered
    await flushPromises()
    expect(domain.p2pManagement.catalog.value?.computers).toHaveLength(0)
    expect(ui.get('[data-testid="p2p-network-status"]').text()).toContain('登录状态待确认')
    await domain.p2pAccounts.currentUser(serviceId)
    await flushPromises()
    expect(ui.get('[data-testid="p2p-network-status"]').text()).toContain('已登录')
    expect(ui.find('[data-testid="p2p-network-reason"]').exists()).toBe(false)
  })

  it('keeps transport diagnostics separate from confirmed signed-out status', async () => {
    const ui = await render({
      serviceSessions: sessionReader([
        { serviceId, state: 'offline', code: 'p2p.device_unregistered' }
      ]),
      currentUser: async () => ({
        ok: false,
        code: 'p2p.user_login_required',
        message: 'no account session'
      })
    })
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pEnrollment.state(serviceId).registration = registered
    await domain.p2pAccounts.currentUser(serviceId)
    await flushPromises()
    expect(ui.get('[data-testid="p2p-network-status"]').text()).toContain('未登录')
    // Without the refusal the user saw an unexplained offline and had nothing to
    // act on; the cause was only reachable by inspecting files.
    expect(ui.get('[data-testid="p2p-network-reason"]').text()).toContain('p2p.device_unregistered')
  })

  it.each([
    ['p2p.certificate_recovery_required', '原网络所有者'],
    ['p2p.certificate_recovery_forbidden', '无权恢复']
  ])(
    'shows actionable certificate recovery copy for %s while retaining enrollment',
    async (code, copy) => {
      const ui = await render({
        serviceSessions: sessionReader([{ serviceId, state: 'offline', code }])
      })
      const domain = await import('@/app/domains/remote-connections')
      domain.p2pEnrollment.state(serviceId).registration = registered
      await flushPromises()
      const reason = ui.get('[data-testid="p2p-network-reason"]').text()
      expect(reason).toContain(code)
      expect(reason).toContain(copy)
      expect(reason).toContain('配对')
      expect(domain.p2pEnrollment.state(serviceId).registration).toEqual(registered)
      expect(ui.find('[data-testid="p2p-join-network"]').exists()).toBe(false)
    }
  )

  it.each([
    ['p2p.certificate_sync_failed', '网络设备证书同步失败'],
    ['p2p.certificate_persist_failed', '系统凭据存储']
  ])(
    'shows the specific certificate maintenance failure %s while retaining enrollment',
    async (code, copy) => {
      const ui = await render({
        serviceSessions: sessionReader([{ serviceId, state: 'offline', code }])
      })
      const domain = await import('@/app/domains/remote-connections')
      domain.p2pEnrollment.state(serviceId).registration = registered
      await flushPromises()
      const reason = ui.get('[data-testid="p2p-network-reason"]').text()
      expect(reason).toContain(code)
      expect(reason).toContain(copy)
      expect(reason).toContain('原设备和配对会保留')
      expect(domain.p2pEnrollment.state(serviceId).registration).toEqual(registered)
      expect(ui.find('[data-testid="p2p-join-network"]').exists()).toBe(false)
    }
  )

  it('offers no leave without a session and says why, rather than failing on click', async () => {
    const leaveNetwork = vi.fn<P2PManagementApi['leaveNetwork']>()
    const ui = await render({ leaveNetwork })
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pEnrollment.state(serviceId).registration = registered
    await flushPromises()
    // The coordinator has no login-free removal, so the action is unavailable
    // until the owner signs in. The reason is stated, not left to be guessed.
    expect(ui.get('[data-testid="p2p-leave-network"]').attributes('disabled')).toBeDefined()
    expect(ui.find('[data-testid="p2p-leave-requires-login"]').exists()).toBe(true)
    await ui.get('[data-testid="p2p-leave-network"]').trigger('click')
    await flushPromises()
    expect(leaveNetwork).not.toHaveBeenCalled()
  })

  it('leaves with the owner session and surfaces a refusal without dropping the registration', async () => {
    const leaveNetwork = vi.fn<P2PManagementApi['leaveNetwork']>().mockResolvedValue({
      ok: false,
      code: 'p2p.network_unauthorized',
      message: 'refused'
    })
    const ui = await render({ leaveNetwork })
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pAccounts.state(serviceId).user = { userId: 'u'.repeat(12), username: 'owner' }
    domain.p2pAccounts.state(serviceId).sessionStatus = 'signedIn'
    domain.p2pEnrollment.state(serviceId).registration = registered
    domain.p2pEnrollment.state(serviceId).joinNetworkIdDraft = 'network-a'
    await flushPromises()
    expect(ui.find('[data-testid="p2p-leave-requires-login"]').exists()).toBe(false)
    await ui.get('[data-testid="p2p-leave-network"]').trigger('click')
    await flushPromises()
    const error = ui.get('[data-testid="p2p-leave-error"]')
    expect(error.text()).toContain('p2p.network_unauthorized')
    // A refused removal must not look like a completed one.
    expect(ui.find('[data-testid="p2p-joined-state"]').exists()).toBe(true)
    expect(leaveNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId, networkId: 'network-a', deviceId: 'device-a' })
    )
  })

  it('surfaces a full-network refusal as a typed error and keeps the form retryable', async () => {
    const joinNetwork = vi.fn<P2PManagementApi['joinNetwork']>().mockResolvedValue({
      ok: false,
      code: 'p2p.network_full',
      message: 'network full'
    })
    const ui = await render({ joinNetwork })
    await ui.get('[data-testid="p2p-join-network"]').setValue('network-full')
    await ui.get('[data-testid="p2p-join-form"]').trigger('submit')
    await flushPromises()
    const error = ui.get('[data-testid="p2p-join-error"]')
    expect(error.text()).toContain('已达到组网设备数上限')
    expect(error.text()).toContain('p2p.network_full')
    expect(ui.find('[data-testid="p2p-joined-state"]').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(true)
  })

  it('shows the unavailable state when the catalog holds no official server', async () => {
    // The catalog was read successfully and simply has no built-in service, and
    // adding one is refused: that is 'unavailable', not a read failure.
    const catalog = vi
      .fn<P2PManagementApi['catalog']>()
      .mockResolvedValue({ ok: true, data: { ...saved, services: [] } })
    const addService = vi
      .fn<P2PManagementApi['addService']>()
      .mockResolvedValue({ ok: false, code: 'p2p.catalog_conflict', message: 'conflict' })
    const ui = await render({ catalog, addService })
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pManagement.catalog.value = { ...saved, services: [] }
    domain.p2pManagement.selectedServiceId.value = undefined
    await flushPromises()
    expect(ui.get('[data-testid="p2p-service-unavailable"]').text()).toContain('官方服务器暂不可用')
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
  })

  it('surfaces a catalog read failure as retryable instead of claiming no configuration', async () => {
    // A failed read must never look like 'not configured'.
    const catalog = vi
      .fn<P2PManagementApi['catalog']>()
      .mockResolvedValue({ ok: false, code: 'p2p.request_replayed', message: 'replayed' })
    const localDevice = vi.fn<P2PManagementApi['localDevice']>().mockResolvedValue({
      ok: true,
      data: { deviceId: 'local-device-a'.padEnd(32, 'a'), name: 'My mac' }
    })
    window.dshLauncher = {
      p2pManagement: { catalog, localDevice, serviceSessions: sessionReader() }
    } as unknown as DesktopApi
    const component = (await import('../components/P2PJoinPanel.vue')).default
    wrapper = mount(component)
    await flushPromises()
    const error = wrapper.get('[data-testid="p2p-catalog-error"]')
    expect(error.text()).toContain('p2p.request_replayed')
    expect(error.find('button').exists()).toBe(true)
    expect(wrapper.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
  })

  it('shows the terminal removed state for a forgotten official server', async () => {
    const ui = await render({})
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pManagement.builtinRemoved.value = true
    await flushPromises()
    expect(ui.get('[data-testid="p2p-builtin-removed"]').text()).toContain('官方服务器已被移除')
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
  })

  /**
   * A record written by an older release cannot be read by any operation, so a
   * retry can never succeed. The card must say what happened, warn that nothing is
   * deleted, and offer the one act that works — discarding it and starting over.
   */
  it('offers to discard a catalog this build cannot read', async () => {
    const catalog = vi
      .fn<P2PManagementApi['catalog']>()
      .mockResolvedValue({ ok: false, code: 'p2p.catalog_invalid', message: 'invalid' })
    const resetCatalog = vi
      .fn<P2PManagementApi['resetCatalog']>()
      .mockResolvedValue({ ok: true, data: { ...saved, services: [] } })
    const addService = vi
      .fn<P2PManagementApi['addService']>()
      .mockResolvedValue({ ok: true, data: saved })
    const localDevice = vi.fn<P2PManagementApi['localDevice']>().mockResolvedValue({
      ok: true,
      data: { deviceId: 'local-device-a'.padEnd(32, 'a'), name: 'My mac' }
    })
    window.dshLauncher = {
      p2pManagement: {
        catalog,
        resetCatalog,
        addService,
        localDevice,
        serviceSessions: sessionReader()
      }
    } as unknown as DesktopApi
    const component = (await import('../components/P2PJoinPanel.vue')).default
    wrapper = mount(component)
    await flushPromises()
    const error = wrapper.get('[data-testid="p2p-catalog-error"]')
    expect(error.text()).toContain('p2p.catalog_invalid')
    expect(wrapper.get('[data-testid="p2p-catalog-unreadable"]').text()).toContain('不会被自动删除')
    const discard = wrapper.get('[data-testid="p2p-catalog-discard"]')
    await discard.trigger('click')
    await flushPromises()
    expect(resetCatalog).toHaveBeenCalledTimes(1)
    // The user gets a working page: the fresh catalog is provisioned, not left empty.
    expect(addService).toHaveBeenCalledTimes(1)
  })

  /** A failure a discard cannot repair must keep the plain retry. */
  it('keeps the retry when the catalog failure is not an unreadable record', async () => {
    const catalog = vi
      .fn<P2PManagementApi['catalog']>()
      .mockResolvedValue({ ok: false, code: 'p2p.catalog_unavailable', message: 'unavailable' })
    const localDevice = vi.fn<P2PManagementApi['localDevice']>().mockResolvedValue({
      ok: true,
      data: { deviceId: 'local-device-a'.padEnd(32, 'a'), name: 'My mac' }
    })
    window.dshLauncher = {
      p2pManagement: { catalog, localDevice, serviceSessions: sessionReader() }
    } as unknown as DesktopApi
    const component = (await import('../components/P2PJoinPanel.vue')).default
    wrapper = mount(component)
    await flushPromises()
    expect(wrapper.find('[data-testid="p2p-catalog-discard"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="p2p-catalog-error"]').find('button').exists()).toBe(true)
  })

  /**
   * A device id can be bound to more than one account, and the account stored in
   * the local credential is only the one the machine first enrolled under. So the
   * coordinator's own list for the signed-in account decides whether the machine
   * belongs there: a machine added to another account's network by hand is bound,
   * not foreign, and saying otherwise sent the user to re-enroll a machine that was
   * already working. Before that list is read, nothing is claimed.
   */
  it('says when the signed-in account has no such device, and only then', async () => {
    const bound = directoryReader()
    const ui = await render({ directory: bound })
    const domain = await import('@/app/domains/remote-connections')

    // Signed in as somebody else, but the account's device list has not been read.
    domain.p2pAccounts.state(serviceId).user = {
      userId: 'user-b',
      username: 'other@test.local'
    } as never
    await flushPromises()
    expect(bound).not.toHaveBeenCalled()
    expect(ui.find('[data-testid="p2p-identity-conflict"]').exists()).toBe(false)

    domain.p2pEnrollment.state(serviceId).registration = registered
    await flushPromises()
    // Read, and this machine is not among the account's devices: that is a conflict.
    expect(bound).toHaveBeenCalledWith(expect.objectContaining({ serviceId }))
    expect(ui.get('[data-testid="p2p-identity-conflict"]').text()).toContain('没有这台电脑')

    // The same machine, now bound to the account: nothing to report.
    bound.mockResolvedValue({
      ok: true,
      data: {
        known: true,
        revision: 2,
        fetchedAt: 1_789_445_714,
        networks: [],
        devices: [boundDevice(registered.deviceId)]
      }
    })
    domain.p2pAccounts.state(serviceId).user = {
      userId: 'user-c',
      username: 'third@test.local'
    } as never
    await flushPromises()
    expect(ui.find('[data-testid="p2p-identity-conflict"]').exists()).toBe(false)

    // The account the machine was enrolled by is not a conflict either.
    domain.p2pAccounts.state(serviceId).user = {
      userId: registered.userId,
      username: 'owner@test.local'
    } as never
    await flushPromises()
    expect(ui.find('[data-testid="p2p-identity-conflict"]').exists()).toBe(false)
  })

  /**
   * An unread directory is not evidence about the account.
   *
   * The read answers from the core's snapshot, which the core may not have read
   * yet — and it starts that read on its own. Treating the resulting empty list as
   * "this machine is not bound" reported a perfectly bound computer as foreign, so
   * the card stays silent until the directory is actually known.
   */
  it('reports no foreign identity while the directory has not been read', async () => {
    const unread = vi.fn<P2PManagementApi['directory']>().mockResolvedValue({
      ok: true,
      data: { known: false, revision: 0, fetchedAt: 0, networks: [], devices: [] }
    })
    const ui = await render({ directory: unread })
    const domain = await import('@/app/domains/remote-connections')

    domain.p2pAccounts.state(serviceId).user = {
      userId: 'user-b',
      username: 'other@test.local'
    } as never
    domain.p2pEnrollment.state(serviceId).registration = registered
    await flushPromises()
    // The read happened; its `known:false` answer is simply not a claim.
    expect(unread).toHaveBeenCalledWith(expect.objectContaining({ serviceId }))
    expect(ui.find('[data-testid="p2p-identity-conflict"]').exists()).toBe(false)
  })
})
