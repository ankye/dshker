import { describe, expect, it, vi } from 'vitest'
import type { RemoteComputerView } from '../../../src/shared/contracts'
import { RemoteConnectionService } from './service'

const computer: RemoteComputerView = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Studio Mac',
  host: 'studio-mac',
  port: 22,
  user: 'dev'
}

function catalog(initial: readonly RemoteComputerView[] = [computer]) {
  let records = [...initial]
  return {
    load: vi.fn(async () => records),
    create: vi.fn(async () => records),
    update: vi.fn(async () => records),
    remove: vi.fn(async (connectionId: string) => {
      records = records.filter((entry) => entry.connectionId !== connectionId)
      return records
    })
  }
}

describe('RemoteConnectionService', () => {
  it('restores records disconnected and publishes ready without persisting the URL', async () => {
    const store = catalog()
    const stop = vi.fn(async () => undefined)
    const connector = {
      connect: vi.fn(async () => ({ url: 'http://127.0.0.1:41000/?token=abc', stop }))
    }
    const service = new RemoteConnectionService(store, connector)
    const events: string[] = []
    service.onStateChange((state) => events.push(state.connections[0]?.status.kind ?? 'empty'))
    expect((await service.getState()).connections[0]?.status.kind).toBe('disconnected')
    expect((await service.getState()).connections[0]?.testStatus.kind).toBe('untested')
    expect((await service.connect(computer.connectionId)).connections[0]?.status.kind).toBe('ready')
    expect((await service.getState()).connections[0]?.testStatus.kind).toBe('passed')
    expect(events).toEqual(['connecting', 'ready'])
    expect(store.create).not.toHaveBeenCalled()
    await service.disconnect(computer.connectionId)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('tests the complete connector path, stops it, and remains disconnected', async () => {
    const stop = vi.fn(async () => undefined)
    const connector = {
      connect: vi.fn(async () => ({ url: 'http://127.0.0.1:41000/?token=abc', stop }))
    }
    const service = new RemoteConnectionService(catalog(), connector)
    const testStates: string[] = []
    service.onStateChange((state) =>
      testStates.push(state.connections[0]?.testStatus.kind ?? 'empty')
    )

    const state = await service.test(computer.connectionId)

    expect(connector.connect).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(state.connections[0]?.status.kind).toBe('disconnected')
    expect(state.connections[0]?.testStatus.kind).toBe('passed')
    expect(testStates).toEqual(['testing', 'passed'])
  })

  it('reports a typed failed test without leaving a live connection', async () => {
    const service = new RemoteConnectionService(catalog(), {
      connect: vi.fn(async () => {
        throw new Error('boom')
      })
    })

    await expect(service.test(computer.connectionId)).rejects.toThrow('boom')
    const state = await service.getState()
    expect(state.connections[0]?.status.kind).toBe('disconnected')
    expect(state.connections[0]?.testStatus).toMatchObject({
      kind: 'failed',
      code: 'remote.tunnel_failed'
    })
  })

  it('rejects connect while a connection test is still active', async () => {
    let resolveTunnel: ((value: { url: string; stop(): Promise<void> }) => void) | undefined
    const connector = {
      connect: vi.fn(
        () =>
          new Promise<{ url: string; stop(): Promise<void> }>((resolve) => {
            resolveTunnel = resolve
          })
      )
    }
    const service = new RemoteConnectionService(catalog(), connector)
    const testing = service.test(computer.connectionId)
    await Promise.resolve()

    await expect(service.connect(computer.connectionId)).rejects.toMatchObject({
      code: 'remote.connection_busy'
    })
    resolveTunnel?.({
      url: 'http://127.0.0.1:41000/',
      stop: vi.fn(async () => undefined)
    })
    await testing
  })

  it('retains a failed row and requires disconnect before removal', async () => {
    const store = catalog()
    const service = new RemoteConnectionService(store, {
      connect: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    await expect(service.connect(computer.connectionId)).rejects.toThrow('boom')
    expect((await service.getState()).connections[0]?.status.kind).toBe('failed')
    await expect(service.remove(computer.connectionId)).rejects.toMatchObject({
      code: 'remote.connection_not_disconnected'
    })
    await service.disconnect(computer.connectionId)
    expect((await service.remove(computer.connectionId)).connections).toEqual([])
  })

  it('fences a late connection after disconnect cancellation', async () => {
    let resolveTunnel: ((value: { url: string; stop(): Promise<void> }) => void) | undefined
    let connectionSignal: AbortSignal | undefined
    const stop = vi.fn(async () => undefined)
    const connector = {
      connect: vi.fn(
        (_computer: RemoteComputerView, _onExit: () => void, signal?: AbortSignal) =>
          new Promise<{ url: string; stop(): Promise<void> }>((resolve) => {
            connectionSignal = signal
            resolveTunnel = resolve
          })
      )
    }
    const service = new RemoteConnectionService(catalog(), connector)
    const connecting = service.connect(computer.connectionId)
    await vi.waitFor(() => expect(connectionSignal).toBeDefined())
    await service.disconnect(computer.connectionId)
    expect(connectionSignal?.aborted).toBe(true)
    resolveTunnel?.({ url: 'http://127.0.0.1:41000/', stop })
    expect((await connecting).connections[0]?.status.kind).toBe('disconnected')
    expect(stop).toHaveBeenCalledOnce()
  })
})
