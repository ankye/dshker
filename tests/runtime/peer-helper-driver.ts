import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { PeerSupervisor } from '../../electron/main/p2p/supervisor'
import { exactPeerObject, PeerHelperError } from '../../electron/main/p2p/wire'

const resourcesRoot = process.argv[2]
assert(resourcesRoot && isAbsolute(resourcesRoot), 'explicit absolute resources root required')
const signal = AbortSignal.timeout(30_000)
let unavailable = 0
const supervisor = await PeerSupervisor.start(
  {
    resourcesRoot,
    handler: async () => {
      throw new PeerHelperError('p2p.unexpected_callback')
    },
    onUnavailable: () => {
      unavailable++
    }
  },
  signal
)
try {
  const keys = await Promise.all(
    Array.from({ length: 8 }, () => supervisor.rpc.call('device.createKey', {}, signal))
  )
  const identities = new Set<string>()
  for (const value of keys) {
    const key = exactPeerObject(value, ['privateKey', 'csr'])
    assert.equal(typeof key.privateKey, 'string')
    assert.equal(typeof key.csr, 'string')
    const privateBytes = Buffer.from(key.privateKey as string, 'base64')
    assert.equal(privateBytes.length, 64)
    assert((key.csr as string).startsWith('-----BEGIN CERTIFICATE REQUEST-----'))
    const rebuilt = exactPeerObject(
      await supervisor.rpc.call('device.createCSR', { privateKey: key.privateKey }, signal),
      ['csr']
    )
    assert.equal(rebuilt.csr, key.csr, 'rebuilding the CSR must preserve the original identity')
    identities.add(privateBytes.subarray(32).toString('hex'))
    privateBytes.fill(0)
  }
  assert.equal(identities.size, 8, 'concurrent calls must retain distinct key identities')
  await assert.rejects(
    supervisor.rpc.call('device.createKey', { extra: true }, signal),
    (error: unknown) => error instanceof PeerHelperError && error.code === 'p2p.invalid_request'
  )
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    supervisor.rpc.call('device.createKey', {}, cancelled.signal),
    (error: unknown) => error instanceof PeerHelperError && error.code === 'p2p.request_cancelled'
  )
} finally {
  await supervisor.close()
}
assert.equal(unavailable, 1)
await assert.rejects(
  supervisor.rpc.call('device.createKey', {}, signal),
  (error: unknown) => error instanceof PeerHelperError && error.code === 'p2p.helper_unavailable'
)
await supervisor.close()
console.log(
  JSON.stringify({
    classification: 'diagnostic',
    realGoHelper: true,
    concurrentKeyCalls: 8,
    originalKeyCSRReadback: true,
    strictAdmission: true,
    cancelledAdmission: true,
    shutdownConfirmed: true
  })
)
