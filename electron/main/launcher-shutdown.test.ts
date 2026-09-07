import { describe, expect, it, vi } from 'vitest'
import { shutdownLauncherOwners } from './launcher-shutdown'

function fixture() {
  return {
    peerManagement: { close: vi.fn(async () => undefined) },
    remoteConnectionService: { shutdown: vi.fn(async () => undefined) },
    remotePeerBroker: { shutdown: vi.fn(async () => undefined) },
    launcherHarnessService: { shutdown: vi.fn(async () => undefined) }
  }
}

describe('Launcher shutdown ownership', () => {
  it('waits for forwarding cleanup before stopping DSH', async () => {
    const owners = fixture()
    let release!: () => void
    owners.peerManagement.close.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined)
        })
    )
    const stopping = shutdownLauncherOwners(owners)
    await Promise.resolve()
    expect(owners.remoteConnectionService.shutdown).toHaveBeenCalledTimes(1)
    expect(owners.remotePeerBroker.shutdown).toHaveBeenCalledTimes(1)
    expect(owners.launcherHarnessService.shutdown).not.toHaveBeenCalled()
    release()
    await stopping
    expect(owners.launcherHarnessService.shutdown).toHaveBeenCalledTimes(1)
  })

  it.each(['peer', 'ssh', 'broker', 'runtime'])(
    'preserves a %s failure without skipping other owners',
    async (target) => {
      const owners = fixture()
      const operations = {
        peer: owners.peerManagement.close,
        ssh: owners.remoteConnectionService.shutdown,
        broker: owners.remotePeerBroker.shutdown,
        runtime: owners.launcherHarnessService.shutdown
      }
      const failure = new Error(`${target} cleanup failed`)
      operations[target as keyof typeof operations].mockRejectedValueOnce(failure)
      await expect(shutdownLauncherOwners(owners)).rejects.toMatchObject({ errors: [failure] })
      for (const operation of Object.values(operations)) expect(operation).toHaveBeenCalledTimes(1)
    }
  )

  it('retains every failure including a synchronous owner exception', async () => {
    const owners = fixture()
    const first = new Error('helper cleanup failed')
    const second = new Error('DSH cleanup failed')
    owners.peerManagement.close.mockImplementationOnce(() => {
      throw first
    })
    owners.launcherHarnessService.shutdown.mockRejectedValueOnce(second)
    await expect(shutdownLauncherOwners(owners)).rejects.toMatchObject({ errors: [first, second] })
    expect(owners.remoteConnectionService.shutdown).toHaveBeenCalledTimes(1)
    expect(owners.remotePeerBroker.shutdown).toHaveBeenCalledTimes(1)
  })
})
