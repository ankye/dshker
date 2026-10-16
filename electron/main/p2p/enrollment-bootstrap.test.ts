import { describe, expect, it, vi } from 'vitest'
import type { PeerRegistrationReadback } from './credentials'
import { enrollWhenMissing } from './enrollment-bootstrap'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(12)

function fixture() {
  const loadRegistration = vi
    .fn<() => Promise<PeerRegistrationReadback>>()
    .mockRejectedValue(new PeerHelperError('p2p.credential_unavailable'))
  const host = {
    credentials: { loadRegistration, loadUserSession: vi.fn() },
    signIn: vi.fn(async () => true),
    networks: vi.fn(async () => [{ networkId: 'b'.repeat(12) }]),
    createNetwork: vi.fn(async () => ({ networkId: 'c'.repeat(12) })),
    register: vi.fn(async () => undefined)
  }
  const enroll = () =>
    enrollWhenMissing(host, serviceId, 'This machine', new AbortController().signal)
  return { host, enroll, loadRegistration }
}

describe('enrollment bootstrap credential admission', () => {
  it.each([
    'p2p.credential_invalid',
    'p2p.credential_read_failed',
    'p2p.identity_mismatch',
    'p2p.secret_provider_unavailable'
  ])('does not create a replacement enrollment after %s', async (code) => {
    const f = fixture()
    f.loadRegistration.mockRejectedValueOnce(new PeerHelperError(code))
    await expect(f.enroll()).rejects.toMatchObject({ code })
    expect(f.host.signIn).not.toHaveBeenCalled()
    expect(f.host.networks).not.toHaveBeenCalled()
    expect(f.host.register).not.toHaveBeenCalled()
  })

  it('does not replace a pending enrollment', async () => {
    const f = fixture()
    f.loadRegistration.mockResolvedValueOnce({ kind: 'pending' } as PeerRegistrationReadback)
    await expect(f.enroll()).resolves.toBe(false)
    expect(f.host.register).not.toHaveBeenCalled()
    expect(f.host.signIn).not.toHaveBeenCalled()
  })

  it('keeps an existing expired credential registered rather than enrolling again', async () => {
    const f = fixture()
    f.loadRegistration.mockResolvedValueOnce({ kind: 'registered' } as PeerRegistrationReadback)
    await expect(f.enroll()).resolves.toBe(true)
    expect(f.host.register).not.toHaveBeenCalled()
    expect(f.host.signIn).not.toHaveBeenCalled()
  })

  it('enrolls only the explicitly missing credential through the existing account policy', async () => {
    const f = fixture()
    await expect(f.enroll()).resolves.toBe(true)
    expect(f.host.register).toHaveBeenCalledWith(serviceId, 'b'.repeat(12), 'This machine')
    expect(f.host.createNetwork).not.toHaveBeenCalled()
  })
})
