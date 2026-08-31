import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import nodePath from 'node:path'
import { ManagedRootError } from './errors'
import { GitRuntimeError } from './git'
import type { GitExecutableRegistration, GitNamedRemote, GitRevisionSelection } from './git'
import { assertGitNamedRemote, assertGitRevisionSelection, parseGitCommitSha } from './git'
import type { NodeExecutableRegistration, PnpmExecutableRegistration } from './toolchain'
import { assertOpaqueId, pathApiFor, type ManagedPathStyle } from './validation'

/** Persisted identity for the Launcher-owned managed Harness installation catalog. */
export const MANAGED_INSTALLATION_CATALOG_FORMAT =
  'dsh-launcher.managed-installation-catalog' as const

/** First strict, non-compatible catalog revision. */
export const MANAGED_INSTALLATION_CATALOG_VERSION = 3 as const

/** One externally selected toolchain pinned for an installation and its future revisions. */
export interface ManagedToolchainRecord {
  readonly toolchainId: string
  readonly git: GitExecutableRegistration
  readonly node: NodeExecutableRegistration
  readonly pnpm: PnpmExecutableRegistration
}

/** One exact managed Harness revision materialized by the Launcher Git manager. */
export interface ManagedHarnessInstallationRecord {
  readonly installationId: string
  readonly workspaceId: string
  /** Toolchain identity that created and can later update this installation. */
  readonly toolchainId: string
  readonly remote: GitNamedRemote
  readonly selection: GitRevisionSelection
  readonly commit: string
  readonly observedReference: string
  readonly observedObject: string
  readonly tagObject?: string
}

/** Complete Launcher-owned installation catalog, independently persisted from the root registry. */
export interface ManagedInstallationCatalog {
  readonly format: typeof MANAGED_INSTALLATION_CATALOG_FORMAT
  readonly version: typeof MANAGED_INSTALLATION_CATALOG_VERSION
  readonly toolchains: readonly ManagedToolchainRecord[]
  readonly installations: readonly ManagedHarnessInstallationRecord[]
}

/** Explicit location of the catalog below an already selected Settings root. */
export interface ManagedInstallationCatalogLocation {
  readonly filePath: string
  readonly pathStyle: ManagedPathStyle
}

/** Strict parser and atomic persistence for managed Harness installation records. */
export class ManagedInstallationCatalogStore {
  readonly #location: ManagedInstallationCatalogLocation

  constructor(location: ManagedInstallationCatalogLocation) {
    this.#location = location
  }

  /** Reads one authoritative catalog; missing state is a recovery error, not an empty default. */
  async load(): Promise<ManagedInstallationCatalog> {
    let text: string
    try {
      text = await readFile(this.#location.filePath, 'utf8')
    } catch (error) {
      if (isNodeCode(error, 'ENOENT')) {
        throw new ManagedRootError(
          'managed.missing_registry',
          'Managed installation catalog is missing.'
        )
      }
      throw persistenceError('Unable to read the managed installation catalog.', error)
    }
    return parseManagedInstallationCatalog(text)
  }

  /** Atomically replaces a fully validated catalog and proves exact readback. */
  async save(catalog: ManagedInstallationCatalog): Promise<void> {
    validateManagedInstallationCatalog(catalog)
    await assertNotSymlink(this.#location.filePath)
    const parent = nodePath.dirname(this.#location.filePath)
    const temporaryPath = nodePath.join(
      parent,
      `.${nodePath.basename(this.#location.filePath)}.${randomUUID()}.tmp`
    )
    const serialized = `${JSON.stringify(catalog, null, 2)}\n`
    try {
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(serialized, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporaryPath, this.#location.filePath)
      await syncParentDirectory(parent)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw persistenceError('Unable to persist the managed installation catalog.', error)
    }
    const reloaded = await this.load()
    if (JSON.stringify(reloaded) !== JSON.stringify(catalog)) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'Managed installation catalog readback differs from the committed record.'
      )
    }
  }
}

/** Derives the only installation-catalog file below the fixed Launcher registry directory. */
export function managedInstallationCatalogFilePath(
  settingsRoot: string,
  style: ManagedPathStyle
): string {
  const pathApi = pathApiFor(style)
  return pathApi.join(settingsRoot, 'dsh-launcher', 'managed-installation-catalog.json')
}

/** Constructs the exact empty catalog that must be persisted during initial root setup. */
export function createEmptyManagedInstallationCatalog(): ManagedInstallationCatalog {
  return {
    format: MANAGED_INSTALLATION_CATALOG_FORMAT,
    version: MANAGED_INSTALLATION_CATALOG_VERSION,
    toolchains: [],
    installations: []
  }
}

/** Parses all catalog fields and refuses any compatibility or unknown-field fallback. */
export function parseManagedInstallationCatalog(text: string): ManagedInstallationCatalog {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw persistenceError('Managed installation catalog is not valid JSON.', error)
  }
  const record = exactRecord(
    value,
    ['format', 'version', 'toolchains', 'installations'],
    'Managed installation catalog'
  )
  if (record.format !== MANAGED_INSTALLATION_CATALOG_FORMAT) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed installation catalog format is invalid.'
    )
  }
  if (record.version !== MANAGED_INSTALLATION_CATALOG_VERSION) {
    throw new ManagedRootError(
      'managed.unsupported_version',
      'Managed installation catalog version is unsupported.'
    )
  }
  if (!Array.isArray(record.toolchains) || !Array.isArray(record.installations)) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed installation catalog records are invalid.'
    )
  }
  const catalog: ManagedInstallationCatalog = {
    format: MANAGED_INSTALLATION_CATALOG_FORMAT,
    version: MANAGED_INSTALLATION_CATALOG_VERSION,
    toolchains: record.toolchains.map(parseToolchain),
    installations: record.installations.map(parseInstallation)
  }
  validateManagedInstallationCatalog(catalog)
  return catalog
}

/** Verifies catalog uniqueness and every nested persisted Git identity before use. */
export function validateManagedInstallationCatalog(catalog: ManagedInstallationCatalog): void {
  if (
    catalog.format !== MANAGED_INSTALLATION_CATALOG_FORMAT ||
    catalog.version !== MANAGED_INSTALLATION_CATALOG_VERSION
  ) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed installation catalog identity is invalid.'
    )
  }
  const toolchainIds = new Set<string>()
  for (const toolchain of catalog.toolchains) {
    assertOpaqueId(toolchain.toolchainId, 'Managed toolchain id')
    if (toolchainIds.has(toolchain.toolchainId)) {
      throw new ManagedRootError('managed.invalid_record', 'Managed toolchain ids must be unique.')
    }
    toolchainIds.add(toolchain.toolchainId)
    assertGitExecutableRegistrationRecord(toolchain.git)
    assertNodeExecutableRegistrationRecord(toolchain.node)
    assertPnpmExecutableRegistrationRecord(toolchain.pnpm, toolchain.node)
  }
  const installationIds = new Set<string>()
  for (const installation of catalog.installations) {
    assertOpaqueId(installation.installationId, 'Managed installation id')
    assertOpaqueId(installation.workspaceId, 'Managed installation workspace id')
    assertOpaqueId(installation.toolchainId, 'Managed installation toolchain id')
    if (installationIds.has(installation.installationId)) {
      throw new ManagedRootError(
        'managed.invalid_record',
        'Managed installation ids must be unique.'
      )
    }
    installationIds.add(installation.installationId)
    if (!toolchainIds.has(installation.toolchainId)) {
      throw new ManagedRootError(
        'managed.invalid_record',
        'Managed installation references an unavailable toolchain.'
      )
    }
    assertManagedGitRecord(() => assertGitNamedRemote(installation.remote))
    assertManagedGitRecord(() => assertGitRevisionSelection(installation.selection))
    parseManagedGitCommit(installation.commit)
    parseManagedGitCommit(installation.observedObject)
    if (
      typeof installation.observedReference !== 'string' ||
      installation.observedReference.length === 0
    ) {
      throw new ManagedRootError(
        'managed.invalid_record',
        'Managed installation observed reference is invalid.'
      )
    }
    if (installation.tagObject !== undefined) parseManagedGitCommit(installation.tagObject)
    if (installation.selection.kind === 'tag' && installation.tagObject === undefined) {
      throw new ManagedRootError(
        'managed.invalid_record',
        'Managed tag installation lacks its observed tag object.'
      )
    }
    if (installation.selection.kind !== 'tag' && installation.tagObject !== undefined) {
      throw new ManagedRootError(
        'managed.invalid_record',
        'Managed non-tag installation includes a tag object.'
      )
    }
  }
}

function parseInstallation(value: unknown): ManagedHarnessInstallationRecord {
  const record = recordWithOptionalFields(
    value,
    [
      'installationId',
      'workspaceId',
      'toolchainId',
      'remote',
      'selection',
      'commit',
      'observedReference',
      'observedObject'
    ],
    ['tagObject'],
    'Managed installation'
  )
  if (
    typeof record.installationId !== 'string' ||
    typeof record.workspaceId !== 'string' ||
    typeof record.toolchainId !== 'string' ||
    typeof record.commit !== 'string' ||
    typeof record.observedReference !== 'string' ||
    typeof record.observedObject !== 'string' ||
    (record.tagObject !== undefined && typeof record.tagObject !== 'string')
  ) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed installation scalar fields are invalid.'
    )
  }
  const remote = parseNamedRemote(record.remote)
  const selection = parseRevisionSelection(record.selection)
  return {
    installationId: record.installationId,
    workspaceId: record.workspaceId,
    toolchainId: record.toolchainId,
    remote,
    selection,
    commit: record.commit,
    observedReference: record.observedReference,
    observedObject: record.observedObject,
    ...(record.tagObject === undefined ? {} : { tagObject: record.tagObject })
  }
}

function parseToolchain(value: unknown): ManagedToolchainRecord {
  const record = exactRecord(value, ['toolchainId', 'git', 'node', 'pnpm'], 'Managed toolchain')
  if (typeof record.toolchainId !== 'string') {
    throw new ManagedRootError('managed.invalid_record', 'Managed toolchain id is invalid.')
  }
  return {
    toolchainId: record.toolchainId,
    git: parseGitExecutableRegistration(record.git),
    node: parseNodeExecutableRegistration(record.node),
    pnpm: parsePnpmExecutableRegistration(record.pnpm)
  }
}

function parseGitExecutableRegistration(value: unknown): GitExecutableRegistration {
  const record = exactRecord(
    value,
    ['requestedPath', 'canonicalPath', 'fingerprint', 'version'],
    'Managed installation Git executable'
  )
  if (typeof record.requestedPath !== 'string' || typeof record.canonicalPath !== 'string') {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed installation Git paths are invalid.'
    )
  }
  const fingerprintRecord = exactRecord(
    record.fingerprint,
    ['device', 'inode', 'size', 'modifiedAtMilliseconds'],
    'Managed installation Git fingerprint'
  )
  const versionRecord = exactRecord(
    record.version,
    ['major', 'minor', 'patch', 'text'],
    'Managed installation Git version'
  )
  const git: GitExecutableRegistration = {
    requestedPath: record.requestedPath,
    canonicalPath: record.canonicalPath,
    fingerprint: {
      device: numericIdentityField(fingerprintRecord.device, 'Git device'),
      inode: numericIdentityField(fingerprintRecord.inode, 'Git inode'),
      size: numericIdentityField(fingerprintRecord.size, 'Git size'),
      modifiedAtMilliseconds: numericIdentityField(
        fingerprintRecord.modifiedAtMilliseconds,
        'Git modification time'
      )
    },
    version: parseGitVersionRecord(versionRecord)
  }
  assertGitExecutableRegistrationRecord(git)
  return git
}

function assertGitExecutableRegistrationRecord(value: GitExecutableRegistration): void {
  assertNormalizedAbsolutePath(value.requestedPath, 'Managed installation Git requested path')
  assertNormalizedAbsolutePath(value.canonicalPath, 'Managed installation Git canonical path')
  numericIdentityField(value.fingerprint.device, 'Git device')
  numericIdentityField(value.fingerprint.inode, 'Git inode')
  numericIdentityField(value.fingerprint.size, 'Git size')
  numericIdentityField(value.fingerprint.modifiedAtMilliseconds, 'Git modification time')
  parseGitVersionRecord(value.version)
}

function parseGitVersionRecord(value: unknown): GitExecutableRegistration['version'] {
  const record = exactRecord(
    value,
    ['major', 'minor', 'patch', 'text'],
    'Managed installation Git version'
  )
  const major = numericIdentityField(record.major, 'Git major version')
  const minor = numericIdentityField(record.minor, 'Git minor version')
  const patch = numericIdentityField(record.patch, 'Git patch version')
  if (typeof record.text !== 'string' || record.text !== `${major}.${minor}.${patch}`) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed installation Git version is invalid.'
    )
  }
  return { major, minor, patch, text: record.text }
}

function parseNodeExecutableRegistration(value: unknown): NodeExecutableRegistration {
  const record = exactRecord(
    value,
    ['requestedPath', 'canonicalPath', 'fingerprint', 'version'],
    'Managed toolchain Node executable'
  )
  if (typeof record.requestedPath !== 'string' || typeof record.canonicalPath !== 'string') {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed toolchain Node paths are invalid.'
    )
  }
  const node: NodeExecutableRegistration = {
    requestedPath: record.requestedPath,
    canonicalPath: record.canonicalPath,
    fingerprint: parseToolchainFingerprint(
      record.fingerprint,
      'Managed toolchain Node fingerprint'
    ),
    version: parseToolchainVersion(record.version, 'Managed toolchain Node version')
  }
  assertNodeExecutableRegistrationRecord(node)
  return node
}

function parsePnpmExecutableRegistration(value: unknown): PnpmExecutableRegistration {
  const record = exactRecord(
    value,
    ['requestedPath', 'canonicalPath', 'fingerprint', 'launcher', 'version'],
    'Managed toolchain pnpm executable'
  )
  if (typeof record.requestedPath !== 'string' || typeof record.canonicalPath !== 'string') {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed toolchain pnpm paths are invalid.'
    )
  }
  const pnpm: PnpmExecutableRegistration = {
    requestedPath: record.requestedPath,
    canonicalPath: record.canonicalPath,
    fingerprint: parseToolchainFingerprint(
      record.fingerprint,
      'Managed toolchain pnpm fingerprint'
    ),
    launcher: parsePnpmLauncher(record.launcher),
    version: parseToolchainVersion(record.version, 'Managed toolchain pnpm version')
  }
  assertPnpmExecutableRegistrationRecord(pnpm)
  return pnpm
}

function parseToolchainFingerprint(
  value: unknown,
  subject: string
): NodeExecutableRegistration['fingerprint'] {
  const record = exactRecord(
    value,
    ['device', 'inode', 'mode', 'size', 'modifiedAtMilliseconds', 'changedAtMilliseconds'],
    subject
  )
  return {
    device: numericIdentityField(record.device, `${subject} device`),
    inode: numericIdentityField(record.inode, `${subject} inode`),
    mode: numericIdentityField(record.mode, `${subject} mode`),
    size: numericIdentityField(record.size, `${subject} size`),
    modifiedAtMilliseconds: numericIdentityField(
      record.modifiedAtMilliseconds,
      `${subject} modification time`
    ),
    changedAtMilliseconds: numericIdentityField(
      record.changedAtMilliseconds,
      `${subject} change time`
    )
  }
}

function parseToolchainVersion(
  value: unknown,
  subject: string
): NodeExecutableRegistration['version'] {
  const record = exactRecord(value, ['major', 'minor', 'patch', 'text'], subject)
  const major = numericIdentityField(record.major, `${subject} major`)
  const minor = numericIdentityField(record.minor, `${subject} minor`)
  const patch = numericIdentityField(record.patch, `${subject} patch`)
  if (typeof record.text !== 'string' || record.text !== `${major}.${minor}.${patch}`) {
    throw new ManagedRootError('managed.invalid_record', `${subject} is invalid.`)
  }
  return { major, minor, patch, text: record.text }
}

function parsePnpmLauncher(value: unknown): PnpmExecutableRegistration['launcher'] {
  const record = recordWithOptionalFields(
    value,
    ['kind'],
    ['node'],
    'Managed toolchain pnpm launcher'
  )
  if (record.kind === 'native') {
    exactRecord(value, ['kind'], 'Managed toolchain native pnpm launcher')
    return { kind: 'native' }
  }
  if (record.kind !== 'node-script') {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed toolchain pnpm launcher is invalid.'
    )
  }
  const nodeScript = exactRecord(
    value,
    ['kind', 'node'],
    'Managed toolchain pnpm Node-script launcher'
  )
  return { kind: 'node-script', node: parseNodeExecutableRegistration(nodeScript.node) }
}

function assertNodeExecutableRegistrationRecord(value: NodeExecutableRegistration): void {
  assertNormalizedAbsolutePath(value.requestedPath, 'Managed toolchain Node requested path')
  assertNormalizedAbsolutePath(value.canonicalPath, 'Managed toolchain Node canonical path')
  assertToolchainFingerprint(value.fingerprint, 'Managed toolchain Node fingerprint')
  parseToolchainVersion(value.version, 'Managed toolchain Node version')
}

function assertPnpmExecutableRegistrationRecord(
  value: PnpmExecutableRegistration,
  expectedNode?: NodeExecutableRegistration
): void {
  assertNormalizedAbsolutePath(value.requestedPath, 'Managed toolchain pnpm requested path')
  assertNormalizedAbsolutePath(value.canonicalPath, 'Managed toolchain pnpm canonical path')
  assertToolchainFingerprint(value.fingerprint, 'Managed toolchain pnpm fingerprint')
  parseToolchainVersion(value.version, 'Managed toolchain pnpm version')
  if (value.launcher.kind === 'native') return
  if (value.launcher.kind !== 'node-script') {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed toolchain pnpm launcher is invalid.'
    )
  }
  assertNodeExecutableRegistrationRecord(value.launcher.node)
  if (expectedNode !== undefined && !sameNodeRegistration(value.launcher.node, expectedNode)) {
    throw new ManagedRootError(
      'managed.invalid_record',
      'Managed toolchain pnpm launcher must use its registered Node executable.'
    )
  }
}

function assertToolchainFingerprint(
  value: NodeExecutableRegistration['fingerprint'],
  subject: string
): void {
  numericIdentityField(value.device, `${subject} device`)
  numericIdentityField(value.inode, `${subject} inode`)
  numericIdentityField(value.mode, `${subject} mode`)
  numericIdentityField(value.size, `${subject} size`)
  numericIdentityField(value.modifiedAtMilliseconds, `${subject} modification time`)
  numericIdentityField(value.changedAtMilliseconds, `${subject} change time`)
}

function sameNodeRegistration(
  left: NodeExecutableRegistration,
  right: NodeExecutableRegistration
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function numericIdentityField(value: unknown, subject: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ManagedRootError('managed.invalid_record', `${subject} is invalid.`)
  }
  return value
}

function assertNormalizedAbsolutePath(value: unknown, subject: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    !nodePath.isAbsolute(value) ||
    nodePath.normalize(value) !== value ||
    nodePath.parse(value).root === value
  ) {
    throw new ManagedRootError('managed.invalid_record', `${subject} is invalid.`)
  }
}

function parseNamedRemote(value: unknown): GitNamedRemote {
  const record = exactRecord(value, ['name', 'source'], 'Managed installation remote')
  if (typeof record.name !== 'string' || !record.source || typeof record.source !== 'object') {
    throw new ManagedRootError('managed.invalid_record', 'Managed installation remote is invalid.')
  }
  const remote = { name: record.name, source: record.source } as unknown as GitNamedRemote
  assertManagedGitRecord(() => assertGitNamedRemote(remote))
  return remote
}

function parseRevisionSelection(value: unknown): GitRevisionSelection {
  const preliminary = recordWithOptionalFields(
    value,
    ['kind'],
    ['branch', 'tag', 'commit'],
    'Managed installation selection'
  )
  if (preliminary.kind === 'branch') {
    const record = exactRecord(value, ['kind', 'branch'], 'Managed installation branch selection')
    if (typeof record.branch !== 'string') {
      throw new ManagedRootError(
        'managed.invalid_record',
        'Managed installation branch is invalid.'
      )
    }
    const selection: GitRevisionSelection = { kind: 'branch', branch: record.branch }
    assertManagedGitRecord(() => assertGitRevisionSelection(selection))
    return selection
  }
  if (preliminary.kind === 'tag') {
    const record = exactRecord(value, ['kind', 'tag'], 'Managed installation tag selection')
    if (typeof record.tag !== 'string') {
      throw new ManagedRootError('managed.invalid_record', 'Managed installation tag is invalid.')
    }
    const selection: GitRevisionSelection = { kind: 'tag', tag: record.tag }
    assertManagedGitRecord(() => assertGitRevisionSelection(selection))
    return selection
  }
  if (preliminary.kind === 'commit') {
    const record = exactRecord(value, ['kind', 'commit'], 'Managed installation commit selection')
    if (typeof record.commit !== 'string') {
      throw new ManagedRootError(
        'managed.invalid_record',
        'Managed installation commit is invalid.'
      )
    }
    const selection: GitRevisionSelection = {
      kind: 'commit',
      commit: parseManagedGitCommit(record.commit)
    }
    assertManagedGitRecord(() => assertGitRevisionSelection(selection))
    return selection
  }
  throw new ManagedRootError('managed.invalid_record', 'Managed installation selection is invalid.')
}

function exactRecord(
  value: unknown,
  expected: readonly string[],
  subject: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedRootError('managed.invalid_record', `${subject} must be an object.`)
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record)
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new ManagedRootError('managed.invalid_record', `${subject} fields are invalid.`)
  }
  return record
}

function recordWithOptionalFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  subject: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedRootError('managed.invalid_record', `${subject} must be an object.`)
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record)
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    actual.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new ManagedRootError('managed.invalid_record', `${subject} fields are invalid.`)
  }
  return record
}

function parseManagedGitCommit(value: string): ReturnType<typeof parseGitCommitSha> {
  try {
    return parseGitCommitSha(value)
  } catch (error) {
    throw asInvalidManagedGitRecord(error)
  }
}

function assertManagedGitRecord(operation: () => void): void {
  try {
    operation()
  } catch (error) {
    throw asInvalidManagedGitRecord(error)
  }
}

function asInvalidManagedGitRecord(error: unknown): ManagedRootError {
  if (error instanceof ManagedRootError) return error
  if (error instanceof GitRuntimeError) {
    return new ManagedRootError(
      'managed.invalid_record',
      'Managed installation Git record is invalid.',
      {
        gitCode: error.code
      }
    )
  }
  return new ManagedRootError(
    'managed.invalid_record',
    'Managed installation Git record is invalid.',
    {
      cause: error instanceof Error ? error.name : 'unknown'
    }
  )
}

async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'Managed installation catalog path must not be a symbolic link.'
      )
    }
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return
    if (error instanceof ManagedRootError) throw error
    throw persistenceError('Unable to inspect the managed installation catalog path.', error)
  }
}

async function syncParentDirectory(parent: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(parent, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function persistenceError(message: string, cause: unknown): ManagedRootError {
  return new ManagedRootError('managed.persistence_failed', message, {
    cause: cause instanceof Error ? cause.name : 'unknown'
  })
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}
