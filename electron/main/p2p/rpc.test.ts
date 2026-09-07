import { createServer, connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerRpc, type PeerMainHandler } from './rpc'
import { decodePeerFrame } from './wire'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation()
})

async function channel(handler: PeerMainHandler = async () => ({})) {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test listener unavailable')
  const accepted = once(server, 'connection')
  const socket = connect(address.port, '127.0.0.1')
  const [remote] = (await accepted) as [Socket]
  const closed = vi.fn()
  const rpc = new PeerRpc(socket, handler, closed)
  cleanup.push(async () => {
    rpc.close()
    remote.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { rpc, remote, closed }
}

describe('private helper RPC lifecycle', () => {
  it('routes out-of-order responses by request identity', async () => {
    const { rpc, remote } = await channel()
    const first = rpc.call('device.createKey', {}, AbortSignal.timeout(1000))
    const second = rpc.call('device.createKey', {}, AbortSignal.timeout(1000))
    remote.write(
      JSON.stringify({
        version: 1,
        id: 2,
        method: '',
        payload: { identity: 'second' },
        error: ''
      }) + '\n'
    )
    remote.write(
      JSON.stringify({ version: 1, id: 1, method: '', payload: { identity: 'first' }, error: '' }) +
        '\n'
    )
    expect(await first).toEqual({ identity: 'first' })
    expect(await second).toEqual({ identity: 'second' })
  })

  it('settles pending requests and notifies exactly once on malformed input', async () => {
    const { rpc, remote, closed } = await channel()
    const pending = rpc.call('device.createKey', {}, AbortSignal.timeout(1000))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'p2p.protocol_mismatch' })
    remote.write('{"version":1,"version":2}\n')
    await rejected
    rpc.close()
    expect(closed).toHaveBeenCalledTimes(1)
    await expect(rpc.call('device.createKey', {}, AbortSignal.timeout(1000))).rejects.toMatchObject(
      { code: 'p2p.helper_unavailable' }
    )
  })

  it('admits only named main callbacks and retains their identity', async () => {
    const handler = vi.fn(async (_method, payload) => payload)
    const { remote } = await channel(handler)
    const result = once(remote, 'data')
    remote.write(
      JSON.stringify({
        version: 1,
        id: 3,
        method: 'peer.state',
        payload: { pairId: 'owned-pair' },
        error: ''
      }) + '\n'
    )
    const [data] = await result
    expect(decodePeerFrame(data.toString().trim())).toMatchObject({
      id: 3,
      method: '',
      payload: { pairId: 'owned-pair' },
      error: ''
    })
    expect(handler).toHaveBeenCalledWith(
      'peer.state',
      { pairId: 'owned-pair' },
      expect.any(AbortSignal)
    )
    const refused = once(remote, 'data')
    remote.write(
      JSON.stringify({ version: 1, id: 4, method: 'shell.exec', payload: {}, error: '' }) + '\n'
    )
    const [failure] = await refused
    expect(decodePeerFrame(failure.toString().trim())).toMatchObject({
      id: 4,
      error: 'p2p.invalid_operation'
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
