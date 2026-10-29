import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { APP_METADATA } from '../../src/shared/contracts'
import { parseManagedBootstrapLocator } from './managed/bootstrap-locator'
import { parseManagedRootRegistry } from './managed/registry'

export type LauncherDistributionChannel = 'stable' | 'test'

/** Main-process startup refusals happen before a profile or credential store is opened. */
export class LauncherProfileError extends Error {
  constructor(
    readonly code:
      | 'launcher.invalid_distribution'
      | 'launcher.test_profile_required'
      | 'launcher.test_profile_invalid'
  ) {
    super(code)
    this.name = 'LauncherProfileError'
  }
}

export interface LauncherProfile {
  readonly distribution: LauncherDistributionChannel
  readonly isolated: boolean
  readonly testRoot?: string
  readonly launcherRoot: string
  readonly userData: string
  readonly dshHome: string
  readonly nativeHome: string
}

export interface LauncherProfileOptions {
  readonly distribution: LauncherDistributionChannel
  readonly argv: readonly string[]
  readonly environment: NodeJS.ProcessEnv
  readonly nativeHome: string
  readonly formalUserData: string
}

/** Missing metadata in a packaged application is not an implicit stable release. */
export function readLauncherDistribution(
  packaged: boolean,
  appPath: string
): LauncherDistributionChannel {
  if (!packaged) return 'test'
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(appPath, 'package.json'), 'utf8'))
    const channel = (value as { dshkerDistributionChannel?: unknown })?.dshkerDistributionChannel
    if (channel === 'stable' || channel === 'test') return channel
  } catch {
    // The same typed refusal covers missing, malformed and incompatible metadata.
  }
  throw new LauncherProfileError('launcher.invalid_distribution')
}

function selectedTestRoot(options: LauncherProfileOptions): string | undefined {
  let selected: string | undefined
  for (let index = 0; index < options.argv.length; index += 1) {
    const argument = options.argv[index]
    if (argument === '--dshker-test-root' || argument.startsWith('--dshker-test-root=')) {
      if (selected !== undefined) throw new LauncherProfileError('launcher.test_profile_invalid')
      selected =
        argument === '--dshker-test-root'
          ? options.argv[++index]
          : argument.slice('--dshker-test-root='.length)
      if (!selected || selected.startsWith('--'))
        throw new LauncherProfileError('launcher.test_profile_invalid')
    }
  }
  const inherited = options.environment.DSHKER_TEST_PROFILE_ROOT
  if (
    selected !== undefined &&
    inherited !== undefined &&
    path.resolve(selected) !== path.resolve(inherited)
  ) {
    throw new LauncherProfileError('launcher.test_profile_invalid')
  }
  return selected ?? inherited
}

/** Canonicalizes existing ancestors without creating a directory or following a selected final link. */
function canonicalPath(value: string): string {
  const missing: string[] = []
  let cursor = path.resolve(value)
  for (;;) {
    try {
      const info = lstatSync(cursor)
      if (cursor === path.resolve(value) && info.isSymbolicLink()) {
        throw new LauncherProfileError('launcher.test_profile_invalid')
      }
      return path.join(realpathSync.native(cursor), ...missing.reverse())
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
        throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw new LauncherProfileError('launcher.test_profile_invalid')
      missing.push(path.basename(cursor))
      cursor = parent
    }
  }
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function nativeDshHome(options: LauncherProfileOptions): string {
  const configured = options.environment.DSH_HOME
  return configured?.trim()
    ? path.resolve(
        configured === '~'
          ? options.nativeHome
          : configured.startsWith('~/') || configured.startsWith('~\\')
            ? path.join(options.nativeHome, configured.slice(2))
            : configured
      )
    : path.join(options.nativeHome, '.dsh')
}

/** Only reads formal registration metadata; missing files mean no registered pointer. */
function formalRegisteredRoots(options: LauncherProfileOptions): readonly string[] {
  const optionalRead = (filePath: string): string | undefined => {
    try {
      return readFileSync(filePath, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return undefined
      throw error
    }
  }
  try {
    const locatorText = optionalRead(
      path.join(options.formalUserData, 'dsh-launcher-bootstrap.json')
    )
    if (locatorText === undefined) return []
    const style = process.platform === 'win32' ? 'win32' : 'posix'
    const nativeHome = nativeDshHome(options)
    const locator = parseManagedBootstrapLocator(locatorText, style, nativeHome)
    const settings = locator.settingsRootCanonicalPath
    const registryText = optionalRead(
      path.join(settings, 'dsh-launcher', 'managed-root-registry.json')
    )
    if (registryText === undefined) return [settings]
    const registry = parseManagedRootRegistry(registryText, style, nativeHome)
    return [
      settings,
      ...registry.roots.map((root) => root.canonicalPath),
      ...registry.workspaces.map((workspace) => workspace.workingDirectoryCanonicalPath)
    ]
  } catch {
    // An unreadable registration cannot establish that a test root is independent.
    throw new LauncherProfileError('launcher.test_profile_invalid')
  }
}

/** Stable releases keep their existing profile; every test launch names an independent root explicitly. */
export function resolveLauncherProfile(options: LauncherProfileOptions): LauncherProfile {
  const selected = selectedTestRoot(options)
  if (selected === undefined) {
    if (options.distribution === 'test')
      throw new LauncherProfileError('launcher.test_profile_required')
    const dshHome = nativeDshHome(options)
    return {
      distribution: 'stable',
      isolated: false,
      launcherRoot: path.join(options.nativeHome, '.dshlauncher'),
      userData: options.formalUserData,
      dshHome,
      nativeHome: options.nativeHome
    }
  }
  if (
    !selected.trim() ||
    !path.isAbsolute(selected) ||
    path.dirname(path.resolve(selected)) === path.resolve(selected)
  ) {
    throw new LauncherProfileError('launcher.test_profile_invalid')
  }
  const testRoot = canonicalPath(selected)
  for (const protectedRoot of [
    path.join(options.nativeHome, '.dshlauncher'),
    nativeDshHome(options),
    options.formalUserData,
    ...formalRegisteredRoots(options)
  ]) {
    const protectedPath = canonicalPath(protectedRoot)
    if (within(protectedPath, testRoot) || within(testRoot, protectedPath))
      throw new LauncherProfileError('launcher.test_profile_invalid')
  }
  return {
    distribution: options.distribution,
    isolated: true,
    testRoot,
    launcherRoot: path.join(testRoot, 'launcher'),
    userData: path.join(testRoot, 'electron'),
    dshHome: path.join(testRoot, 'dsh-home'),
    nativeHome: path.join(testRoot, 'native-home')
  }
}

/** Test persisted pointers and selected paths cannot escape back into formal state. */
export function assertTestProfilePath(profile: LauncherProfile, value: string): void {
  if (!profile.isolated) return
  if (
    !profile.testRoot ||
    !path.isAbsolute(value) ||
    !within(profile.testRoot, canonicalPath(value))
  ) {
    throw new LauncherProfileError('launcher.test_profile_invalid')
  }
}

/** Validates all fixed destinations before the first directory or log is written. */
export function prepareTestProfile(profile: LauncherProfile): void {
  if (!profile.isolated || !profile.testRoot) return
  const directories = [
    profile.testRoot,
    profile.userData,
    profile.dshHome,
    profile.nativeHome,
    ...['session', 'temp', 'downloads', 'logs', 'crashes'].map((name) =>
      path.join(profile.testRoot!, name)
    ),
    profile.launcherRoot,
    ...[
      'core-data',
      'core-state',
      'harness',
      'versions',
      'plugins',
      'presets',
      'settings',
      'logs'
    ].map((name) => path.join(profile.launcherRoot, name))
  ]
  for (const directory of directories) assertTestProfilePath(profile, directory)
  for (const directory of directories) mkdirSync(directory, { recursive: true })
}

export function launcherDistributionIdentity(channel: LauncherDistributionChannel): {
  appId: string
  productName: string
} {
  return channel === 'test'
    ? { appId: `${APP_METADATA.bundleId}.test`, productName: `${APP_METADATA.name} Test` }
    : { appId: APP_METADATA.bundleId, productName: APP_METADATA.name }
}
