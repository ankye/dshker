// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertTestProfilePath,
  prepareTestProfile,
  readLauncherDistribution,
  resolveLauncherProfile,
  type LauncherProfileOptions
} from './launcher-profile'
import { ProfileBootstrapLocatorStore, ProfileCoreRoots } from './launcher-profile-boundaries'
import { createManagedBootstrapLocator } from './managed/bootstrap-locator'
import {
  MANAGED_ROOT_REGISTRY_FORMAT,
  MANAGED_ROOT_REGISTRY_VERSION,
  type ManagedRootRegistry
} from './managed/model'

const parent = path.resolve('.run', 'profile-isolation-unit')
const fixtures: string[] = []

async function fixture(): Promise<
  LauncherProfileOptions & { root: string; testRoot: string; sentinel: string }
> {
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, 'case-'))
  fixtures.push(root)
  const nativeHome = path.join(root, 'formal-home')
  const formalUserData = path.join(root, 'formal-electron')
  const sentinel = path.join(nativeHome, '.dshlauncher', 'formal-record.json')
  await mkdir(path.dirname(sentinel), { recursive: true })
  await mkdir(formalUserData, { recursive: true })
  await writeFile(sentinel, '{"preserved":"formal"}\n')
  return {
    root,
    testRoot: path.join(root, 'isolated'),
    sentinel,
    distribution: 'test',
    argv: [],
    environment: {},
    nativeHome,
    formalUserData
  }
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) {
    if (!path.relative(parent, root).startsWith('case-'))
      throw new Error('test_cleanup_outside_fixture')
    await rm(root, { recursive: true, force: true })
  }
})

describe('Launcher distribution profile admission', () => {
  it('preserves stable roots, Electron profile and explicitly configured native DSH home', async () => {
    const f = await fixture()
    const configured = path.join(f.root, 'formal-dsh')
    const profile = resolveLauncherProfile({
      ...f,
      distribution: 'stable',
      environment: { DSH_HOME: configured }
    })
    expect(profile).toEqual({
      distribution: 'stable',
      isolated: false,
      launcherRoot: path.join(f.nativeHome, '.dshlauncher'),
      userData: f.formalUserData,
      dshHome: configured,
      nativeHome: f.nativeHome
    })
    expect(await readFile(f.sentinel, 'utf8')).toBe('{"preserved":"formal"}\n')
  })

  it('refuses test and development startup without an explicit independent root', async () => {
    const f = await fixture()
    expect(() => resolveLauncherProfile(f)).toThrow('launcher.test_profile_required')
    expect(readLauncherDistribution(false, f.root)).toBe('test')
    expect(existsSync(f.testRoot)).toBe(false)
    expect(await readFile(f.sentinel, 'utf8')).toBe('{"preserved":"formal"}\n')
  })

  it('requires exact packaged channel metadata instead of guessing a stable install', async () => {
    const f = await fixture()
    expect(() => readLauncherDistribution(true, f.root)).toThrow('launcher.invalid_distribution')
    await writeFile(path.join(f.root, 'package.json'), '{"dshkerDistributionChannel":"stable"}')
    expect(readLauncherDistribution(true, f.root)).toBe('stable')
    await writeFile(path.join(f.root, 'package.json'), '{"dshkerDistributionChannel":"test"}')
    expect(readLauncherDistribution(true, f.root)).toBe('test')
    await writeFile(path.join(f.root, 'package.json'), '{"dshkerDistributionChannel":"unknown"}')
    expect(() => readLauncherDistribution(true, f.root)).toThrow('launcher.invalid_distribution')
  })

  it('places every owned test destination below the selected root and permits isolated stable-package verification', async () => {
    const f = await fixture()
    for (const distribution of ['stable', 'test'] as const) {
      const profile = resolveLauncherProfile({
        ...f,
        distribution,
        argv: ['--dshker-test-root', f.testRoot]
      })
      expect(profile.isolated).toBe(true)
      prepareTestProfile(profile)
      for (const value of [
        profile.launcherRoot,
        profile.userData,
        profile.dshHome,
        profile.nativeHome
      ]) {
        expect(value.startsWith(`${f.testRoot}${path.sep}`)).toBe(true)
        expect(existsSync(value)).toBe(true)
      }
      expect(() => assertTestProfilePath(profile, f.formalUserData)).toThrow(
        'launcher.test_profile_invalid'
      )
      expect(await readFile(f.sentinel, 'utf8')).toBe('{"preserved":"formal"}\n')
    }
  })

  it('rejects relative, empty, duplicate, conflicting and overlapping roots before writes', async () => {
    const f = await fixture()
    for (const selected of [
      '',
      'relative',
      path.parse(f.root).root,
      f.nativeHome,
      path.join(f.nativeHome, '.dshlauncher'),
      path.join(f.nativeHome, '.dshlauncher', 'test'),
      f.formalUserData
    ]) {
      expect(() =>
        resolveLauncherProfile({ ...f, environment: { DSHKER_TEST_PROFILE_ROOT: selected } })
      ).toThrow('launcher.test_profile_invalid')
    }
    expect(() => resolveLauncherProfile({ ...f, argv: ['--dshker-test-root'] })).toThrow(
      'launcher.test_profile_invalid'
    )
    expect(() =>
      resolveLauncherProfile({
        ...f,
        argv: ['--dshker-test-root', f.testRoot, '--dshker-test-root', f.testRoot]
      })
    ).toThrow('launcher.test_profile_invalid')
    expect(() =>
      resolveLauncherProfile({
        ...f,
        argv: [`--dshker-test-root=${f.testRoot}`],
        environment: { DSHKER_TEST_PROFILE_ROOT: path.join(f.root, 'other') }
      })
    ).toThrow('launcher.test_profile_invalid')
    expect(() =>
      resolveLauncherProfile({
        ...f,
        environment: { DSH_HOME: f.testRoot, DSHKER_TEST_PROFILE_ROOT: f.testRoot }
      })
    ).toThrow('launcher.test_profile_invalid')
    expect(existsSync(f.testRoot)).toBe(false)
  })

  it('rejects selected junctions and nested data-directory links without touching formal records', async () => {
    const f = await fixture()
    const link = path.join(f.root, 'linked-profile')
    await symlink(path.dirname(f.sentinel), link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() =>
      resolveLauncherProfile({ ...f, environment: { DSHKER_TEST_PROFILE_ROOT: link } })
    ).toThrow('launcher.test_profile_invalid')
    const profile = resolveLauncherProfile({
      ...f,
      environment: { DSHKER_TEST_PROFILE_ROOT: f.testRoot }
    })
    await mkdir(profile.launcherRoot, { recursive: true })
    await symlink(
      path.dirname(f.sentinel),
      path.join(profile.launcherRoot, 'core-data'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(() => prepareTestProfile(profile)).toThrow('launcher.test_profile_invalid')
    expect(existsSync(profile.userData)).toBe(false)
    expect(await readFile(f.sentinel, 'utf8')).toBe('{"preserved":"formal"}\n')
  })

  it('protects external formal settings, registered roots and workspaces before creating a test profile', async () => {
    const f = await fixture()
    const settings = path.join(f.root, 'external-settings')
    const registryPath = path.join(settings, 'dsh-launcher', 'managed-root-registry.json')
    const roots = ['settings', 'harness', 'plugins', 'presets'].map((kind) => ({
      kind,
      rootId: `formal_${kind}`,
      canonicalPath: kind === 'settings' ? settings : path.join(f.root, `external-${kind}`)
    }))
    const workingDirectory = path.join(f.root, 'formal-workspace')
    const registry = {
      format: MANAGED_ROOT_REGISTRY_FORMAT,
      version: MANAGED_ROOT_REGISTRY_VERSION,
      roots,
      workspaces: [
        {
          workspaceId: 'formal_workspace',
          displayName: 'Formal workspace',
          workingDirectoryCapabilityId: 'formal_capability',
          workingDirectoryCanonicalPath: workingDirectory,
          rootNamespaces: roots.map((root) => ({
            rootId: root.rootId,
            namespace: 'workspaces/formal'
          }))
        }
      ]
    }
    await mkdir(path.dirname(registryPath), { recursive: true })
    const locatorPath = path.join(f.formalUserData, 'dsh-launcher-bootstrap.json')
    await writeFile(locatorPath, JSON.stringify(createManagedBootstrapLocator(settings)))
    await writeFile(registryPath, JSON.stringify(registry))
    const before = await readFile(registryPath, 'utf8')
    for (const root of roots) {
      for (const selected of [root.canonicalPath, path.join(root.canonicalPath, 'test')]) {
        expect(() =>
          resolveLauncherProfile({ ...f, argv: ['--dshker-test-root', selected] })
        ).toThrow('launcher.test_profile_invalid')
      }
    }
    expect(() =>
      resolveLauncherProfile({
        ...f,
        argv: ['--dshker-test-root', path.join(workingDirectory, 'test')]
      })
    ).toThrow('launcher.test_profile_invalid')
    expect(() => resolveLauncherProfile({ ...f, argv: ['--dshker-test-root', f.root] })).toThrow(
      'launcher.test_profile_invalid'
    )
    const independent = resolveLauncherProfile({ ...f, argv: ['--dshker-test-root', f.testRoot] })
    prepareTestProfile(independent)
    expect(await readFile(registryPath, 'utf8')).toBe(before)
    expect(await readFile(f.sentinel, 'utf8')).toBe('{"preserved":"formal"}\n')
    await writeFile(registryPath, '{broken')
    expect(() =>
      resolveLauncherProfile({ ...f, argv: ['--dshker-test-root', f.testRoot] })
    ).toThrow('launcher.test_profile_invalid')
    expect(resolveLauncherProfile({ ...f, distribution: 'stable' }).isolated).toBe(false)
  })
})

describe('test profile persisted-root boundaries', () => {
  it('refuses a copied formal locator and validates an isolated locator round trip', async () => {
    const f = await fixture()
    const profile = resolveLauncherProfile({ ...f, argv: ['--dshker-test-root', f.testRoot] })
    prepareTestProfile(profile)
    const filePath = path.join(profile.userData, 'dsh-launcher-bootstrap.json')
    const store = new ProfileBootstrapLocatorStore(profile, {
      filePath,
      nativeDshHomePath: profile.dshHome,
      pathStyle: process.platform === 'win32' ? 'win32' : 'posix'
    })
    const outside = createManagedBootstrapLocator(path.dirname(f.sentinel))
    await writeFile(filePath, JSON.stringify(outside))
    await expect(store.load()).rejects.toMatchObject({ code: 'managed.root_path_invalid' })
    await expect(store.save(outside)).rejects.toMatchObject({ code: 'managed.root_path_invalid' })
    const inside = createManagedBootstrapLocator(path.join(profile.launcherRoot, 'settings'))
    await store.save(inside)
    expect(await store.load()).toEqual(inside)
    expect(await readFile(f.sentinel, 'utf8')).toBe('{"preserved":"formal"}\n')
  })

  it('rejects external root commits before dispatch and rejects copied external root readbacks', async () => {
    const f = await fixture()
    const profile = resolveLauncherProfile({ ...f, argv: ['--dshker-test-root', f.testRoot] })
    prepareTestProfile(profile)
    const registry: ManagedRootRegistry = {
      format: MANAGED_ROOT_REGISTRY_FORMAT,
      version: MANAGED_ROOT_REGISTRY_VERSION,
      roots: [{ kind: 'settings', rootId: 'test_root', canonicalPath: f.formalUserData }],
      workspaces: []
    }
    const source = {
      inspect: vi.fn(async () => registry),
      commit: vi.fn(async (_location: unknown, value: ManagedRootRegistry) => value)
    }
    const port = new ProfileCoreRoots(profile, source)
    const location = {
      filePath: path.join(profile.launcherRoot, 'settings', 'registry.json'),
      nativeDshHome: profile.dshHome,
      pathStyle: process.platform === 'win32' ? ('win32' as const) : ('posix' as const)
    }
    await expect(port.commit(location, registry)).rejects.toMatchObject({
      code: 'managed.root_path_invalid'
    })
    expect(source.commit).not.toHaveBeenCalled()
    await expect(port.inspect(location)).rejects.toMatchObject({
      code: 'managed.root_path_invalid'
    })
    expect(source.inspect).toHaveBeenCalledOnce()
  })
})
