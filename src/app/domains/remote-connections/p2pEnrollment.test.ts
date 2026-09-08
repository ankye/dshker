import { describe, expect, it, vi } from 'vitest'
import type { P2PManagementApi, P2PRegistrationView } from '@/shared/p2p-management'
import { P2PManagementDomain } from './p2pManagement'
import { P2PEnrollmentDomain } from './p2pEnrollment'

const pending: P2PRegistrationView = {
  kind: 'pending',
  serviceId: 'service-a',
  userId: 'user-a',
  name: 'My computer',
  publicKey: 'public-key',
  revision: 'a'.repeat(64),
  requestId: 'original-request',
  networkId: 'network-a'
}
const issued: P2PRegistrationView = {
  kind: 'registered',
  serviceId: pending.serviceId,
  userId: pending.userId,
  name: pending.name,
  publicKey: pending.publicKey,
  revision: 'b'.repeat(64),
  deviceId: 'device-a'
}
function setup() {
  const api = {
    registration: vi
      .fn<P2PManagementApi['registration']>()
      .mockResolvedValue({ ok: true, data: pending }),
    recoverEnrollment: vi.fn<P2PManagementApi['recoverEnrollment']>().mockResolvedValue({
      ok: false,
      code: 'p2p.enrollment_not_found',
      message: 'not found'
    }),
    submitEnrollment: vi
      .fn<P2PManagementApi['submitEnrollment']>()
      .mockResolvedValue({ ok: true, data: issued }),
    registerDevice: vi.fn<P2PManagementApi['registerDevice']>(),
    joinNetwork: vi.fn<P2PManagementApi['joinNetwork']>()
  }
  const management = new P2PManagementDomain(() => api as unknown as P2PManagementApi)
  return { api, management, enrollment: new P2PEnrollmentDomain(management) }
}

describe('P2P enrollment reconciliation', () => {
  it('preserves unknown state and errors when the local record cannot be read', async () => {
    const { enrollment, api, management } = setup()
    api.registration.mockResolvedValueOnce({
      ok: false,
      code: 'p2p.credential_unavailable',
      message: 'unavailable'
    })
    await enrollment.read('service-a')
    expect(enrollment.state('service-a').registration).toBeUndefined()
    expect(management.operations['service-a'].phase).toBe('failed')
    expect(api.registerDevice).not.toHaveBeenCalled()
  })

  it('invalidates retry permission when the durable record is reread', async () => {
    const { enrollment, api } = setup()
    await enrollment.read('service-a')
    await enrollment.recover('service-a')
    api.registration.mockResolvedValueOnce({
      ok: true,
      data: { ...pending, revision: 'c'.repeat(64) }
    })
    await enrollment.read('service-a')
    await enrollment.submit('service-a')
    expect(api.submitEnrollment).not.toHaveBeenCalled()
    expect(enrollment.state('service-a').retryRevision).toBeUndefined()
  })

  it('does not change reconciliation state while another service operation is pending', async () => {
    const { enrollment, api } = setup()
    await enrollment.read('service-a')
    await enrollment.recover('service-a')
    let finish!: (value: Awaited<ReturnType<P2PManagementApi['registration']>>) => void
    api.registration.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const reading = enrollment.read('service-a')
    await enrollment.recover('service-a')
    await enrollment.submit('service-a')
    expect(enrollment.state('service-a').retryRevision).toBe(pending.revision)
    expect(api.recoverEnrollment).toHaveBeenCalledTimes(1)
    expect(api.submitEnrollment).not.toHaveBeenCalled()
    finish({ ok: true, data: issued })
    await reading
  })

  it('does not equate a local pending record with server absence', async () => {
    const { enrollment, api } = setup()
    await enrollment.read('service-a')
    await enrollment.submit('service-a')
    await enrollment.register('service-a', 'network-a')
    expect(enrollment.state('service-a').resultUnconfirmed).toBe(true)
    expect(api.submitEnrollment).not.toHaveBeenCalled()
    expect(api.registerDevice).not.toHaveBeenCalled()
  })

  it('allows one explicit same-revision submit after an authoritative absence result', async () => {
    const { enrollment, api } = setup()
    await enrollment.read('service-a')
    await enrollment.recover('service-a')
    expect(api.submitEnrollment).not.toHaveBeenCalled()
    await enrollment.submit('service-a')
    await enrollment.submit('service-a')
    expect(api.submitEnrollment).toHaveBeenCalledTimes(1)
    expect(api.submitEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: 'service-a',
        revision: pending.revision
      })
    )
    expect(enrollment.state('service-a').registration).toEqual(issued)
  })

  it('does not replay an uncertain submission after rereading the pending file', async () => {
    const { enrollment, api } = setup()
    api.submitEnrollment.mockRejectedValueOnce(new Error('reply lost'))
    await enrollment.read('service-a')
    await enrollment.recover('service-a')
    await enrollment.submit('service-a')
    await enrollment.read('service-a')
    await enrollment.submit('service-a')
    expect(api.submitEnrollment).toHaveBeenCalledTimes(1)
    expect(enrollment.state('service-a').resultUnconfirmed).toBe(true)
  })

  it('a failed recovery never authorizes a write or changes the saved identity', async () => {
    const { enrollment, api } = setup()
    api.recoverEnrollment.mockResolvedValueOnce({
      ok: false,
      code: 'p2p.server_unavailable',
      message: 'offline'
    })
    await enrollment.read('service-a')
    await enrollment.recover('service-a')
    await enrollment.submit('service-a')
    expect(api.submitEnrollment).not.toHaveBeenCalled()
    expect(enrollment.state('service-a').registration).toEqual(pending)
    expect(enrollment.state('service-b').registration).toBeUndefined()
  })

  it('recovers the existing device without enrolling again', async () => {
    const { enrollment, api } = setup()
    api.recoverEnrollment.mockResolvedValueOnce({ ok: true, data: issued })
    await enrollment.read('service-a')
    await enrollment.recover('service-a')
    expect(enrollment.state('service-a').registration).toEqual(issued)
    expect(enrollment.state('service-a').resultUnconfirmed).toBe(false)
    expect(api.registerDevice).not.toHaveBeenCalled()
    expect(api.submitEnrollment).not.toHaveBeenCalled()
  })

  describe('P2P login-free join enrollment', () => {
    it('stores only a server-confirmed registered join result', async () => {
      const { enrollment, api } = setup()
      api.joinNetwork.mockResolvedValueOnce({ ok: true, data: issued })
      await enrollment.join('service-a', 'network-b', 'My computer')
      expect(api.joinNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceId: 'service-a',
          networkId: 'network-b',
          name: 'My computer'
        })
      )
      expect(enrollment.state('service-a').registration).toEqual(issued)
      expect(enrollment.state('service-a').resultUnconfirmed).toBe(false)
      expect(api.registerDevice).not.toHaveBeenCalled()
    })

    it('never turns a network_full refusal into a registration and stays retryable', async () => {
      const { enrollment, api } = setup()
      api.joinNetwork.mockResolvedValueOnce({
        ok: false,
        code: 'p2p.network_full',
        message: 'network is full'
      })
      await enrollment.join('service-a', 'network-full', 'My computer')
      expect(enrollment.state('service-a').registration).toBeUndefined()
      expect(enrollment.state('service-a').resultUnconfirmed).toBe(false)
      expect(enrollment.state('service-a').joinNetworkIdDraft).toBe('')
    })

    it('treats invalid_enrollment as a typed refusal without blocking readback', async () => {
      const { enrollment, api } = setup()
      api.joinNetwork.mockResolvedValueOnce({
        ok: false,
        code: 'p2p.invalid_enrollment',
        message: 'bad enrollment'
      })
      await enrollment.join('service-a', 'network-b', 'My computer')
      expect(enrollment.state('service-a').resultUnconfirmed).toBe(false)
      expect(api.registration).toHaveBeenCalledTimes(0)
    })

    it('marks a lost join reply as unconfirmed instead of inventing a registration', async () => {
      const { enrollment, api } = setup()
      api.joinNetwork.mockRejectedValueOnce(new Error('reply lost'))
      await enrollment.join('service-a', 'network-b', 'My computer')
      expect(enrollment.state('service-a').registration).toBeUndefined()
      expect(enrollment.state('service-a').resultUnconfirmed).toBe(true)
    })

    it('refuses a second join while a local registration already exists', async () => {
      const { enrollment, api } = setup()
      await enrollment.read('service-a')
      await enrollment.join('service-a', 'network-b', 'My computer')
      expect(api.joinNetwork).not.toHaveBeenCalled()
    })

    it('surfaces a pending join result as unconfirmed, not registered', async () => {
      const { enrollment, api } = setup()
      api.joinNetwork.mockResolvedValueOnce({ ok: true, data: pending })
      await enrollment.join('service-a', pending.networkId, pending.name)
      const state = enrollment.state('service-a')
      expect(state.registration).toEqual(pending)
      expect(state.resultUnconfirmed).toBe(true)
    })
  })
})
