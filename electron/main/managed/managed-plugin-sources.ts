import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { ManagedHarnessRuntimeError } from './runtime-errors'
import { assertDirectDirectory, runText } from './process-utils'
import { extractPluginArchive } from './plugin-archive'

const MANAGED_PLUGIN_SOURCE_DIRECTORY = 'managed-sources'
const MANAGED_PLUGIN_SOURCE_DOCUMENT = 'sources.json'

/** A source resolved by typed IPC before main-process materialization. */
export type ManagedPluginInstallSource =
  | { readonly kind: 'git'; readonly url: string }
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'archive'; readonly path: string }

interface ManagedPluginSourceRecord {
  readonly name: string
  /** Root copied or cloned by the Launcher, removed once this plugin is uninstalled. */
  readonly directory: string
  readonly source: ManagedPluginSource
}

interface ManagedPluginSourceDocument {
  readonly format: 'dsh-launcher.plugin-sources'
  readonly version: 2
  readonly records: readonly ManagedPluginSourceRecord[]
}

interface ManagedLocalPluginSource {
  readonly kind: 'local'
}

interface ManagedGitPluginSource extends ManagedGitSource {
  readonly kind: 'git'
  readonly branch: string
  /** Exact checked-out commit currently used by the native profile. */
  readonly revision: string
  /** Result of the most recent explicit source refresh. */
  readonly updateAvailable: boolean
}

type ManagedPluginSource = ManagedLocalPluginSource | ManagedGitPluginSource

/** One source whose installation directory may be a package below its owned clone root. */
export interface MaterializedPluginSource {
  /** Exact package directory given to `dsh plugin add`. */
  readonly installDirectory: string
  /** Launcher-owned root recorded for deterministic cleanup. */
  readonly managedDirectory: string
  /** Persisted source metadata used to determine whether this plugin can update. */
  readonly source: ManagedPluginSource
}

/** One persisted Git source that may be refreshed in place. */
export interface ManagedGitPluginSourceView {
  readonly name: string
  readonly revision: string
  readonly branch: string
  readonly updateAvailable: boolean
}

/** Owns source copies, Git clones, and their package-to-directory records. */
export class ManagedPluginSources {
  readonly #pluginsDirectory: string
  readonly #gitExecutable: string

  constructor(options: Readonly<{ pluginsDirectory: string; gitExecutable: string }>) {
    this.#pluginsDirectory = options.pluginsDirectory
    this.#gitExecutable = options.gitExecutable
  }

  /** Creates one managed source without letting DSH retain an external source path or remote URL. */
  async materialize(source: ManagedPluginInstallSource): Promise<MaterializedPluginSource> {
    const root = this.#root()
    await mkdir(root, { recursive: true })
    const directory = nodePath.join(root, `plugin-${randomUUID()}`)
    if (source.kind === 'local') {
      await assertDirectDirectory(source.path)
      await cp(source.path, directory, { recursive: true, force: false, errorOnExist: true })
      return { installDirectory: directory, managedDirectory: directory, source: { kind: 'local' } }
    }
    if (source.kind === 'archive') {
      try {
        const installDirectory = await extractPluginArchive(source.path, directory)
        return { installDirectory, managedDirectory: directory, source: { kind: 'local' } }
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    }
    const gitSource = parseManagedGitSource(source.url)
    try {
      await runText(this.#gitExecutable, [
        'clone',
        '--depth',
        '1',
        ...(gitSource.branch === undefined ? [] : ['--branch', gitSource.branch]),
        gitSource.cloneUrl,
        directory
      ])
      const installDirectory = nodePath.join(directory, ...gitSource.packagePath)
      await assertDirectDirectory(installDirectory)
      const revision = await this.#readRevision(directory)
      const branch = gitSource.branch ?? (await this.#readBranch(directory))
      return {
        installDirectory,
        managedDirectory: directory,
        source: { kind: 'git', ...gitSource, branch, revision, updateAvailable: false }
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  /** Discards a materialized source only before DSH can retain its path. */
  async discard(directory: string): Promise<void> {
    this.#assertDirectory(directory)
    await rm(directory, { recursive: true, force: true })
  }

  /** Records the source root that owns one successfully installed package. */
  async record(name: string, materialized: MaterializedPluginSource): Promise<void> {
    this.#assertDirectory(materialized.managedDirectory)
    const document = await this.#read()
    if (document.records.some((record) => record.name === name)) {
      throw new ManagedHarnessRuntimeError(
        'runtime.plugin_operation_failed',
        'Plugin source record already exists.'
      )
    }
    await this.#write({
      ...document,
      records: [
        ...document.records,
        { name, directory: materialized.managedDirectory, source: materialized.source }
      ]
    })
  }

  /** Returns Git update metadata for the managed plugins currently present in the native profile. */
  async gitSources(): Promise<ReadonlyMap<string, ManagedGitPluginSourceView>> {
    const sources = new Map<string, ManagedGitPluginSourceView>()
    for (const record of (await this.#read()).records) {
      if (record.source.kind !== 'git') continue
      sources.set(record.name, {
        name: record.name,
        revision: record.source.revision,
        branch: record.source.branch,
        updateAvailable: record.source.updateAvailable
      })
    }
    return sources
  }

  /** Fetches one Git-managed plugin source and records the exact new checkout before DSH reconciles it. */
  async update(name: string): Promise<MaterializedPluginSource> {
    const document = await this.#read()
    const index = document.records.findIndex((record) => record.name === name)
    if (index < 0 || document.records[index] === undefined) {
      throw new ManagedHarnessRuntimeError(
        'runtime.input_invalid',
        'Only a Launcher-managed Git plugin can be updated.'
      )
    }
    const record = document.records[index]
    this.#assertDirectory(record.directory)
    if (record.source.kind !== 'git') {
      throw new ManagedHarnessRuntimeError(
        'runtime.input_invalid',
        'Only a Launcher-managed Git plugin can be updated.'
      )
    }
    await runText(this.#gitExecutable, [
      '-C',
      record.directory,
      'fetch',
      '--prune',
      'origin',
      record.source.branch
    ])
    await runText(this.#gitExecutable, [
      '-C',
      record.directory,
      'checkout',
      '--detach',
      'FETCH_HEAD'
    ])
    const revision = await this.#readRevision(record.directory)
    const source: ManagedGitPluginSource = { ...record.source, revision, updateAvailable: false }
    await this.#write({
      ...document,
      records: document.records.map((candidate, candidateIndex) =>
        candidateIndex === index ? { ...record, source } : candidate
      )
    })
    const installDirectory = nodePath.join(record.directory, ...source.packagePath)
    await assertDirectDirectory(installDirectory)
    return { installDirectory, managedDirectory: record.directory, source }
  }

  /** Fetches each managed Git source without changing the native DSH profile. */
  async refreshGitSourceStatus(): Promise<void> {
    const document = await this.#read()
    const records = await Promise.all(
      document.records.map(async (record): Promise<ManagedPluginSourceRecord> => {
        if (record.source.kind !== 'git') return record
        this.#assertDirectory(record.directory)
        await runText(this.#gitExecutable, [
          '-C',
          record.directory,
          'fetch',
          '--prune',
          'origin',
          record.source.branch
        ])
        const fetchedRevision = (
          await runText(this.#gitExecutable, ['-C', record.directory, 'rev-parse', 'FETCH_HEAD'])
        ).trim()
        if (!/^[0-9a-f]{40}$/u.test(fetchedRevision)) throw invalidRecord()
        return {
          ...record,
          source: { ...record.source, updateAvailable: fetchedRevision !== record.source.revision }
        }
      })
    )
    await this.#write({ ...document, records })
  }

  /** Deletes the exact owned source recorded for a package after DSH removes it. */
  async remove(name: string): Promise<void> {
    const document = await this.#read()
    const record = document.records.find((candidate) => candidate.name === name)
    if (record === undefined) return
    this.#assertDirectory(record.directory)
    await rm(record.directory, { recursive: true, force: false })
    await this.#write({
      ...document,
      records: document.records.filter((candidate) => candidate !== record)
    })
  }

  #root(): string {
    return nodePath.join(this.#pluginsDirectory, MANAGED_PLUGIN_SOURCE_DIRECTORY)
  }

  #documentPath(): string {
    return nodePath.join(this.#root(), MANAGED_PLUGIN_SOURCE_DOCUMENT)
  }

  /** Refuses a persisted mapping that could delete anything outside this managed root. */
  #assertDirectory(directory: string): void {
    const root = nodePath.resolve(this.#root())
    const target = nodePath.resolve(directory)
    const relative = nodePath.relative(root, target)
    if (
      relative.length === 0 ||
      relative === '..' ||
      relative.startsWith(`..${nodePath.sep}`) ||
      nodePath.isAbsolute(relative)
    ) {
      throw new ManagedHarnessRuntimeError(
        'runtime.plugin_operation_failed',
        'Managed plugin source record is invalid.'
      )
    }
  }

  /** Reads the Launcher-owned mapping document; absence means no managed sources yet. */
  async #read(): Promise<ManagedPluginSourceDocument> {
    let source: string
    try {
      source = await readFile(this.#documentPath(), 'utf8')
    } catch (error) {
      if (isMissing(error)) {
        return { format: 'dsh-launcher.plugin-sources', version: 2, records: [] }
      }
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      throw invalidRecord()
    }
    if (
      !isRecord(value) ||
      value.format !== 'dsh-launcher.plugin-sources' ||
      !Array.isArray(value.records)
    ) {
      throw invalidRecord()
    }
    if (value.version === 1) {
      if (value.records.length !== 0) {
        throw new ManagedHarnessRuntimeError(
          'runtime.plugin_operation_failed',
          'Managed plugin sources must be reinstalled before they can be updated.'
        )
      }
      return { format: 'dsh-launcher.plugin-sources', version: 2, records: [] }
    }
    if (value.version !== 2) throw invalidRecord()
    const names = new Set<string>()
    const records = value.records.map((record): ManagedPluginSourceRecord => {
      if (
        !isRecord(record) ||
        typeof record.name !== 'string' ||
        typeof record.directory !== 'string' ||
        !isRecord(record.source) ||
        names.has(record.name)
      ) {
        throw invalidRecord()
      }
      names.add(record.name)
      this.#assertDirectory(record.directory)
      return {
        name: record.name,
        directory: record.directory,
        source: parseManagedPluginSource(record.source)
      }
    })
    return { format: 'dsh-launcher.plugin-sources', version: 2, records }
  }

  async #write(document: ManagedPluginSourceDocument): Promise<void> {
    await mkdir(this.#root(), { recursive: true })
    await writeFile(this.#documentPath(), `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  }

  async #readRevision(directory: string): Promise<string> {
    const revision = (
      await runText(this.#gitExecutable, ['-C', directory, 'rev-parse', 'HEAD'])
    ).trim()
    if (!/^[0-9a-f]{40}$/u.test(revision)) throw invalidRecord()
    return revision
  }

  async #readBranch(directory: string): Promise<string> {
    const branch = (
      await runText(this.#gitExecutable, ['-C', directory, 'branch', '--show-current'])
    ).trim()
    if (branch.length === 0) {
      throw new ManagedHarnessRuntimeError(
        'runtime.plugin_operation_failed',
        'The managed Git plugin has no current branch.'
      )
    }
    return branch
  }
}

interface ManagedGitSource {
  readonly cloneUrl: string
  readonly branch: string | undefined
  /** Package path below the cloned repository root. */
  readonly packagePath: readonly string[]
}

/**
 * Admits a clone URL or the GitHub tree address emitted by the curated catalog.
 *
 * A tree address names a package below a repository root, so the Launcher clones
 * the repository and gives DSH the selected child directory. Direct Git URLs are
 * cloned unchanged and install their repository root.
 */
export function parseManagedGitSource(value: string): ManagedGitSource {
  let source: URL
  try {
    source = new URL(value)
  } catch {
    throw new ManagedHarnessRuntimeError('runtime.input_invalid', 'A HTTPS Git source is required.')
  }
  if (source.protocol !== 'https:' || source.username.length > 0 || source.password.length > 0) {
    throw new ManagedHarnessRuntimeError('runtime.input_invalid', 'A HTTPS Git source is required.')
  }
  const segments = source.pathname.split('/').filter(Boolean)
  if (source.hostname !== 'github.com' || segments[2] !== 'tree') {
    if (segments.length < 2) {
      throw new ManagedHarnessRuntimeError(
        'runtime.input_invalid',
        'A HTTPS Git source is required.'
      )
    }
    return { cloneUrl: source.toString(), branch: undefined, packagePath: [] }
  }
  const [owner, repository, , branch, ...packagePath] = segments
  if (
    owner === undefined ||
    repository === undefined ||
    branch === undefined ||
    packagePath.length === 0
  ) {
    throw new ManagedHarnessRuntimeError(
      'runtime.input_invalid',
      'A GitHub plugin source must name a package directory.'
    )
  }
  return {
    cloneUrl: `https://github.com/${owner}/${repository}.git`,
    branch,
    packagePath
  }
}

/**
 * Builds the exact GitHub package address for a package found below an existing
 * local checkout. The caller must obtain the branch and relative package path
 * from Git; this function refuses to guess either value.
 */
export function githubTreePluginUrl(
  remoteUrl: string,
  branch: string,
  packagePath: readonly string[]
): string {
  let remote: URL
  try {
    remote = new URL(remoteUrl)
  } catch {
    throw new ManagedHarnessRuntimeError(
      'runtime.input_invalid',
      'Only a GitHub HTTPS plugin source can be moved under DSHKer management.'
    )
  }
  const segments = remote.pathname.split('/').filter(Boolean)
  const [owner, repository, ...extra] = segments
  if (
    remote.protocol !== 'https:' ||
    remote.hostname !== 'github.com' ||
    remote.username.length !== 0 ||
    remote.password.length !== 0 ||
    owner === undefined ||
    repository === undefined ||
    extra.length !== 0 ||
    branch.length === 0 ||
    branch.includes('/') ||
    packagePath.length === 0 ||
    packagePath.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new ManagedHarnessRuntimeError(
      'runtime.input_invalid',
      'Only a GitHub HTTPS plugin source with one checked-out branch can be moved under DSHKer management.'
    )
  }
  const repositoryName = repository.replace(/\.git$/u, '')
  if (repositoryName.length === 0) {
    throw new ManagedHarnessRuntimeError(
      'runtime.input_invalid',
      'Only a GitHub HTTPS plugin source can be moved under DSHKer management.'
    )
  }
  return `https://github.com/${owner}/${repositoryName}/tree/${encodeURIComponent(branch)}/${packagePath.map(encodeURIComponent).join('/')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function invalidRecord(): ManagedHarnessRuntimeError {
  return new ManagedHarnessRuntimeError(
    'runtime.plugin_operation_failed',
    'Managed plugin source record is invalid.'
  )
}

function parseManagedPluginSource(value: Record<string, unknown>): ManagedPluginSource {
  if (value.kind === 'local' && Object.keys(value).length === 1) return { kind: 'local' }
  if (
    value.kind !== 'git' ||
    typeof value.cloneUrl !== 'string' ||
    typeof value.revision !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(value.revision) ||
    !Array.isArray(value.packagePath) ||
    value.packagePath.some((segment) => typeof segment !== 'string' || segment.length === 0) ||
    typeof value.branch !== 'string' ||
    value.branch.length === 0 ||
    (value.updateAvailable !== undefined && typeof value.updateAvailable !== 'boolean')
  ) {
    throw invalidRecord()
  }
  return {
    kind: 'git',
    cloneUrl: value.cloneUrl,
    revision: value.revision,
    packagePath: value.packagePath,
    branch: value.branch,
    updateAvailable: value.updateAvailable ?? false
  }
}
