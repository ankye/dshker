import { createServer, connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerRpc, type PeerMainHandler } from './rpc'
import { decodePeerFrame, PeerHelperError } from './wire'

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

  it('admits the directory callback and answers a malformed payload with its typed code', async () => {
    // The strict payload rules live in the composed handler (runtime-host); this
    // asserts the transport carries directory.changed on the same terms as the
    // other parent callbacks and turns the handler's refusal into a typed reply
    // instead of an operation_failed or a closed channel.
    const handler = vi.fn(async (_method, payload) => {
      const fields = payload as { serviceId?: unknown; revision?: unknown }
      if (
        typeof fields.serviceId !== 'string' ||
        !/^[a-f0-9]{12}$/.test(fields.serviceId) ||
        !Number.isSafeInteger(fields.revision) ||
        (fields.revision as number) < 0
      )
        throw new PeerHelperError('p2p.invalid_payload')
      return {}
    })
    const { remote } = await channel(handler)
    const accepted = once(remote, 'data')
    remote.write(
      JSON.stringify({
        version: 1,
        id: 5,
        method: 'directory.changed',
        payload: { serviceId: 'a'.repeat(12), revision: 0 },
        error: ''
      }) + '\n'
    )
    const [answer] = await accepted
    expect(decodePeerFrame(answer.toString().trim())).toMatchObject({
      id: 5,
      method: '',
      payload: {},
      error: ''
    })
    expect(handler).toHaveBeenCalledWith(
      'directory.changed',
      { serviceId: 'a'.repeat(12), revision: 0 },
      expect.any(AbortSignal)
    )

    const refused = once(remote, 'data')
    remote.write(
      JSON.stringify({
        version: 1,
        id: 6,
        method: 'directory.changed',
        payload: { serviceId: 'NOT-HEX', revision: 0 },
        error: ''
      }) + '\n'
    )
    const [malformed] = await refused
    expect(decodePeerFrame(malformed.toString().trim())).toMatchObject({
      id: 6,
      error: 'p2p.invalid_payload'
    })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('admits the named remote-root callback for an attached headless core', async () => {
    const handler = vi.fn(async () => ({ roots: [] }))
    const { remote } = await channel(handler)
    const answer = once(remote, 'data')
    remote.write(
      JSON.stringify({
        version: 1,
        id: 1,
        method: 'runtime.roots',
        payload: { serviceId: 'a'.repeat(12), pairId: 'b'.repeat(12) },
        error: ''
      }) + '\n'
    )
    const [data] = await answer
    expect(decodePeerFrame(data.toString().trim())).toMatchObject({
      id: 1,
      method: '',
      payload: { roots: [] },
      error: ''
    })
    expect(handler).toHaveBeenCalledWith(
      'runtime.roots',
      expect.any(Object),
      expect.any(AbortSignal)
    )
  })
})
