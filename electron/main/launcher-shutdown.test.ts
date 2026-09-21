import { describe, expect, it, vi } from 'vitest'
import { createLauncherQuitSequence, shutdownLauncherOwners } from './launcher-shutdown'

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

  it('hands the attached core back only after connection owners close', async () => {
    const owners = {
      ...fixture(),
      coreSupervisor: { close: vi.fn(async (): Promise<void> => undefined) }
    }
    const order: string[] = []
    owners.peerManagement.close.mockImplementationOnce(async () => void order.push('peer'))
    owners.remoteConnectionService.shutdown.mockImplementationOnce(
      async () => void order.push('ssh')
    )
    owners.remotePeerBroker.shutdown.mockImplementationOnce(async () => void order.push('broker'))
    owners.coreSupervisor = { close: vi.fn(async () => void order.push('core')) }
    await shutdownLauncherOwners(owners)
    expect(order.indexOf('core')).toBeGreaterThan(order.indexOf('peer'))
    expect(order.indexOf('core')).toBeGreaterThan(order.indexOf('ssh'))
    expect(order.indexOf('core')).toBeGreaterThan(order.indexOf('broker'))
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

function quitHost() {
  const order: string[] = []
  return {
    order,
    beginForceQuit: vi.fn(() => void order.push('beginForceQuit')),
    destroyTray: vi.fn(() => void order.push('destroyTray')),
    quit: vi.fn(() => void order.push('quit')),
    exit: vi.fn((code: number) => void order.push(`exit:${code}`)),
    reportFailure: vi.fn(() => void order.push('reportFailure'))
  }
}

describe('Launcher quit sequence', () => {
  /**
   * The regression this exists for. Cmd+Q, the application menu, the Dock's Quit
   * item and a termination signal all reach `app.quit()` without passing through
   * the tray, so the close interception has to be released by the shared quit
   * sequence rather than by the tray alone. Releasing it after the cleanup — or
   * not at all — let the window hide itself instead of closing, which cancelled
   * the quit and left a process with no window, no tray icon, a stopped core and
   * the single-instance lock still held.
   */
  it('releases the close interception before any cleanup runs', async () => {
    const owners = fixture()
    const host = quitHost()
    owners.peerManagement.close.mockImplementationOnce(async () => {
      host.order.push('cleanup')
    })

    await createLauncherQuitSequence(owners, host).run()

    expect(host.order.indexOf('beginForceQuit')).toBeLessThan(host.order.indexOf('cleanup'))
    expect(host.quit).toHaveBeenCalledTimes(1)
  })

  it('destroys the tray only once the quit is certain to proceed', async () => {
    const owners = fixture()
    const host = quitHost()

    await createLauncherQuitSequence(owners, host).run()

    expect(host.order).toEqual(['beginForceQuit', 'destroyTray', 'quit'])
  })

  it('reports completion so the next quit request is not intercepted again', async () => {
    const owners = fixture()
    const sequence = createLauncherQuitSequence(owners, quitHost())

    expect(sequence.isComplete()).toBe(false)
    await sequence.run()
    expect(sequence.isComplete()).toBe(true)
  })

  /**
   * A cleanup failure must not become an application that cannot be quit: the
   * user asked to leave and every owner was already attempted. Staying alive
   * leaves the same hidden process holding the single-instance lock that only
   * Activity Monitor can end.
   */
  it('still ends the process when an owner cleanup fails', async () => {
    const owners = fixture()
    const host = quitHost()
    owners.launcherHarnessService.shutdown.mockRejectedValueOnce(new Error('DSH cleanup failed'))

    const sequence = createLauncherQuitSequence(owners, host)
    await sequence.run()

    expect(host.reportFailure).toHaveBeenCalledTimes(1)
    expect(host.exit).toHaveBeenCalledWith(1)
    expect(host.destroyTray).toHaveBeenCalledTimes(1)
    // The quit never "completed", but the process is ending regardless, so a
    // retry loop that reruns the same failing cleanup cannot form.
    expect(host.quit).not.toHaveBeenCalled()
    expect(sequence.isComplete()).toBe(false)
  })

  it('runs the owners once when several quit paths fire together', async () => {
    const owners = fixture()
    const host = quitHost()
    const sequence = createLauncherQuitSequence(owners, host)

    await Promise.all([sequence.run(), sequence.run(), sequence.run()])

    expect(owners.peerManagement.close).toHaveBeenCalledTimes(1)
    expect(owners.launcherHarnessService.shutdown).toHaveBeenCalledTimes(1)
    expect(host.quit).toHaveBeenCalledTimes(1)
  })
})
