import { describe, expect, it, vi } from 'vitest'
import { restoreUserSession } from './session-registry'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(12)
const persisted = { token: '8'.repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 3600 }

function fixture(failure?: Error) {
  const removeUserSession = vi.fn(async () => undefined)
  const adoptPersistedSession = vi.fn(async () => {
    if (failure) throw failure
  })
  return {
    credentials: {
      loadUserSession: vi.fn(async () => persisted),
      removeUserSession
    },
    session: {
      accounts: {
        hasSession: vi.fn(() => false),
        adoptPersistedSession
      }
    },
    removeUserSession,
    adoptPersistedSession
  }
}

describe('restoreUserSession', () => {
  it('keeps a persisted session when the helper is temporarily busy', async () => {
    const f = fixture(new PeerHelperError('p2p.service_busy'))

    await expect(
      restoreUserSession(f.credentials, f.session, serviceId, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'p2p.service_busy' })
    expect(f.removeUserSession).not.toHaveBeenCalled()
  })

  it('removes a persisted session only after the server rejects its authority', async () => {
    const f = fixture(new PeerHelperError('p2p.user_unauthorized'))

    await expect(
      restoreUserSession(f.credentials, f.session, serviceId, new AbortController().signal)
    ).resolves.toBeUndefined()
    expect(f.removeUserSession).toHaveBeenCalledWith(serviceId)
  })

  it('adopts a valid persisted session without deleting it', async () => {
    const f = fixture()

    await restoreUserSession(f.credentials, f.session, serviceId, new AbortController().signal)

    expect(f.adoptPersistedSession).toHaveBeenCalledWith(
      serviceId,
      persisted.token,
      persisted.expiresAt,
      expect.any(AbortSignal)
    )
    expect(f.removeUserSession).not.toHaveBeenCalled()
  })

  it('does not turn a credential-provider failure into a signed-out session', async () => {
    const failure = new PeerHelperError('p2p.secret_provider_unavailable')
    const f = fixture()
    f.credentials.loadUserSession.mockRejectedValueOnce(failure)

    await expect(
      restoreUserSession(f.credentials, f.session, serviceId, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'p2p.secret_provider_unavailable' })
    expect(f.adoptPersistedSession).not.toHaveBeenCalled()
    expect(f.removeUserSession).not.toHaveBeenCalled()
  })
})
