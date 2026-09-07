import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { LauncherHarnessService } from '../../electron/main/managed/launcher-harness-service'
import { resolvePnpmLauncher } from '../../electron/main/pnpm-launcher'
import { PeerCatalog } from '../../electron/main/p2p/catalog'
import { PeerRuntimeHost } from '../../electron/main/p2p/runtime-host'
import { exactPeerObject, PeerHelperError } from '../../electron/main/p2p/wire'

const resourcesRoot = process.argv[2]
assert(resourcesRoot && isAbsolute(resourcesRoot), 'explicit absolute resources root required')
const root = await mkdtemp(join(tmpdir(), 'dshker-runtime-host-diagnostic-'))
const pnpmLauncher = resolvePnpmLauncher()
const runtime = new LauncherHarnessService({
  harnessDirectory: join(root, 'harness'),
  versionsDirectory: join(root, 'versions'),
  currentVersionPointerPath: join(root, 'current.json'),
  pluginSourcesDirectory: join(root, 'plugins'),
  dshHomeDirectory: join(root, 'dsh-home'),
  launchPreferencesPath: join(root, 'launch.json'),
  launchLogPath: join(root, 'logs', 'web.log'),
  diagnosticsPatchPath: join(root, 'diagnostics.yml'),
  gitExecutable: process.platform === 'win32' ? 'git' : '/usr/bin/git',
  pnpmExecutable: pnpmLauncher.executable,
  pnpmLauncher
})
const catalog = new PeerCatalog(async () => root)
const host = new PeerRuntimeHost({ resourcesRoot, catalog, runtime })
const signal = AbortSignal.timeout(30_000)
try {
  await mkdir(join(root, 'dsh-launcher'))
  await assert.rejects(
    host.start(signal),
    (error: unknown) => error instanceof PeerHelperError && error.code === 'p2p.not_enabled'
  )
  const saved = await catalog.enable()
  const rpc = await host.start(signal)
  assert.equal(await host.start(signal), rpc)
  const keys = await Promise.all(
    Array.from({ length: 8 }, () => rpc.call('device.createKey', {}, signal))
  )
  const publicKeys = new Set<string>()
  for (const value of keys) {
    const result = exactPeerObject(value, ['privateKey', 'csr'])
    assert.equal(typeof result.privateKey, 'string')
    const bytes = Buffer.from(result.privateKey as string, 'base64')
    assert.equal(bytes.length, 64)
    publicKeys.add(bytes.subarray(32).toString('hex'))
    bytes.fill(0)
    assert.equal(typeof result.csr, 'string')
    assert((result.csr as string).startsWith('-----BEGIN CERTIFICATE REQUEST-----'))
  }
  assert.equal(publicKeys.size, 8)
  await assert.rejects(
    rpc.call('device.createKey', { extra: true }, signal),
    (error: unknown) => error instanceof PeerHelperError && error.code === 'p2p.invalid_request'
  )
  assert.deepEqual(await catalog.inspect(), saved, 'helper operations must not rewrite trust')
  assert.deepEqual(runtime.getRuntimeState(), { kind: 'stopped' }, 'management must not start DSH')
  assert.deepEqual(host.snapshot(), { error: '', peers: [] })
  await host.close()
  await assert.rejects(
    rpc.call('device.createKey', {}, signal),
    (error: unknown) => error instanceof PeerHelperError && error.code === 'p2p.helper_unavailable'
  )
  await assert.rejects(
    host.start(signal),
    (error: unknown) => error instanceof PeerHelperError && error.code === 'p2p.helper_closed'
  )
  assert.deepEqual(runtime.getRuntimeState(), { kind: 'stopped' })
} finally {
  await host.close()
  await runtime.shutdown()
  await rm(root, { recursive: true, force: true })
}
console.log(
  JSON.stringify({
    classification: 'diagnostic',
    realGoHelper: true,
    realManagedRuntimeOwner: true,
    concurrentKeyCalls: 8,
    strictAdmission: true,
    catalogReadbackUnchanged: true,
    noImplicitDSHStart: true,
    shutdownConfirmed: true,
    fullAppWorkbenchAcceptance: false
  })
)
