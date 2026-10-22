import type { CoreRootsLocation, CoreRootsPort } from './core/roots'
import {
  ManagedBootstrapLocatorStore,
  type ManagedBootstrapLocator,
  type ManagedBootstrapLocatorLocation
} from './managed/bootstrap-locator'
import { ManagedRootError } from './managed/errors'
import type { ManagedRootRegistry } from './managed/model'
import { assertTestProfilePath, type LauncherProfile } from './launcher-profile'

/** A test profile cannot import a formal locator, registry or native directory selection. */
export function assertProfileStoragePath(profile: LauncherProfile, value: string): void {
  try {
    assertTestProfilePath(profile, value)
  } catch {
    throw new ManagedRootError(
      'managed.root_path_invalid',
      'A test profile storage path must remain inside its explicitly selected test root.'
    )
  }
}

export class ProfileBootstrapLocatorStore extends ManagedBootstrapLocatorStore {
  constructor(
    private readonly profile: LauncherProfile,
    private readonly location: ManagedBootstrapLocatorLocation
  ) {
    super(location)
  }

  override async load(): Promise<ManagedBootstrapLocator> {
    assertProfileStoragePath(this.profile, this.location.filePath)
    const locator = await super.load()
    assertProfileStoragePath(this.profile, locator.settingsRootCanonicalPath)
    return locator
  }

  override async save(locator: ManagedBootstrapLocator): Promise<void> {
    assertProfileStoragePath(this.profile, this.location.filePath)
    assertProfileStoragePath(this.profile, locator.settingsRootCanonicalPath)
    await super.save(locator)
  }
}

function assertRegistry(profile: LauncherProfile, registry: ManagedRootRegistry): void {
  for (const root of registry.roots) assertProfileStoragePath(profile, root.canonicalPath)
  for (const workspace of registry.workspaces)
    assertProfileStoragePath(profile, workspace.workingDirectoryCanonicalPath)
}

/** Narrows existing typed core operations; it adds no renderer capability or second writer. */
export class ProfileCoreRoots implements CoreRootsPort {
  constructor(
    private readonly profile: LauncherProfile,
    private readonly source: CoreRootsPort
  ) {}

  async inspect(location: CoreRootsLocation, signal?: AbortSignal): Promise<ManagedRootRegistry> {
    assertProfileStoragePath(this.profile, location.filePath)
    const registry = await this.source.inspect(location, signal)
    assertRegistry(this.profile, registry)
    return registry
  }

  async commit(
    location: CoreRootsLocation,
    registry: ManagedRootRegistry,
    signal?: AbortSignal
  ): Promise<ManagedRootRegistry> {
    assertProfileStoragePath(this.profile, location.filePath)
    assertRegistry(this.profile, registry)
    const committed = await this.source.commit(location, registry, signal)
    assertRegistry(this.profile, committed)
    return committed
  }
}
