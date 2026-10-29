// @vitest-environment node
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const controls = vi.hoisted(() => ({
  registration: vi.fn((_file, _args, _options, complete) => {
    complete(
      Object.assign(new Error('registered stable job'), { stderr: 'p2p.autostart_conflict' })
    )
  })
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: controls.registration
}))

import { CoreSupervisor, coreProcessEnvironment, type CoreSupervisorOptions } from './supervisor'
import { CoreSecrets } from './secrets'

describe('core credential identity admission', () => {
  it('clears inherited namespace and Electron Node mode for stable helpers without changing the parent', () => {
    const environment = {
      DSHKER_SECRET_NAMESPACE: 'outside',
      ELECTRON_RUN_AS_NODE: '1',
      KEEP: 'same'
    }
    expect(coreProcessEnvironment({}, environment)).toEqual({ KEEP: 'same' })
    expect(environment.DSHKER_SECRET_NAMESPACE).toBe('outside')
  })

  it('derives a repeatable isolated namespace from the explicit canonical root and overrides inheritance', () => {
    const root = path.resolve('.run', 'core-namespace-fixture')
    const first = coreProcessEnvironment(
      { isolatedProfileRoot: root },
      { DSHKER_SECRET_NAMESPACE: 'outside' }
    )
    expect(first.DSHKER_SECRET_NAMESPACE).toBe(
      `profile-${createHash('sha256').update(root).digest('hex')}`
    )
    expect(first).toEqual(coreProcessEnvironment({ isolatedProfileRoot: root }, {}))
    expect(first.DSHKER_SECRET_NAMESPACE).not.toBe(
      coreProcessEnvironment({ isolatedProfileRoot: `${root}-other` }, {}).DSHKER_SECRET_NAMESPACE
    )
    expect(() => coreProcessEnvironment({ isolatedProfileRoot: 'relative' }, {})).toThrow(
      'p2p.invalid_arguments'
    )
  })
})

describe.skipIf(!process.env.DSHKER_CORE_BINARY)('real isolated core autostart boundary', () => {
  let root: string | undefined
  let supervisor: CoreSupervisor | undefined
  afterEach(async () => {
    await supervisor?.close()
    supervisor = undefined
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
    vi.unstubAllEnvs()
    controls.registration.mockClear()
  })

  it('boots despite a conflicting stable registration and rejects autostart over the real channel', async () => {
    const source = process.env.DSHKER_CORE_BINARY
    if (!source) throw new Error('DSHKER_CORE_BINARY required')
    const parent = path.resolve('.run', 'core-profile-boundary')
    await mkdir(parent, { recursive: true })
    root = await mkdtemp(path.join(parent, 'case-'))
    const target = `${process.platform}-${process.arch}`
    const directory = path.join(root, 'p2p', target)
    const name = process.platform === 'win32' ? 'dshkerd.exe' : 'dshkerd'
    await mkdir(directory, { recursive: true })
    await copyFile(source, path.join(directory, name))
    if (process.platform !== 'win32') await chmod(path.join(directory, name), 0o755)
    const bytes = await readFile(source)
    await writeFile(
      path.join(directory, 'dshkerd-manifest.json'),
      JSON.stringify({
        version: 1,
        target,
        file: name,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
    )
    const options: CoreSupervisorOptions = {
      resourcesRoot: root,
      stateRoot: path.join(root, 'state'),
      dataRoot: path.join(root, 'data'),
      catalogRoot: path.join(root, 'catalog'),
      isolatedProfileRoot: root,
      onUnavailable: () => undefined
    }
    vi.stubEnv('DSHKER_SECRET_NAMESPACE', 'inherited-and-never-used')
    await expect(
      CoreSupervisor.start(
        { ...options, isolatedProfileRoot: undefined },
        AbortSignal.timeout(5_000)
      )
    ).rejects.toMatchObject({ code: 'p2p.autostart_conflict' })
    expect(controls.registration).toHaveBeenCalledTimes(1)
    expect(controls.registration.mock.calls[0]?.[2].env.DSHKER_SECRET_NAMESPACE).toBeUndefined()
    controls.registration.mockClear()
    supervisor = await CoreSupervisor.start(options, AbortSignal.timeout(30_000))
    expect(controls.registration).not.toHaveBeenCalled()
    if (process.platform === 'win32') {
      const secrets = new CoreSecrets(supervisor.rpc)
      const namespace = coreProcessEnvironment(options, {}).DSHKER_SECRET_NAMESPACE
      await secrets.set('profile-boundary-test', Buffer.from('isolated-only'))
      expect(await secrets.get('profile-boundary-test')).toEqual(Buffer.from('isolated-only'))
      const files = await readdir(options.dataRoot)
      expect(files).toContain(`credentials.dshkerd.${namespace}.json`)
      expect(files).not.toContain('credentials.json')
      expect(files).not.toContain('credentials.dshkerd.inherited-and-never-used.json')
      await secrets.delete('profile-boundary-test')
    }
    expect(await supervisor.call('core.version', {}, AbortSignal.timeout(5_000))).toMatchObject({
      version: 1
    })
    for (const method of [
      'core.autostart_status',
      'core.autostart_enable',
      'core.autostart_disable'
    ]) {
      await expect(supervisor.call(method, {}, AbortSignal.timeout(5_000))).rejects.toMatchObject({
        code: 'p2p.autostart_unsupported'
      })
    }
    expect(await supervisor.call('core.version', {}, AbortSignal.timeout(5_000))).toMatchObject({
      version: 1
    })
  })
})
