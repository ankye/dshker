import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import nodePath from 'node:path'

/** The only extraResources directory from which a packaged Launcher can import its initial DSH. */
export const BUNDLED_SEED_RESOURCE_DIRECTORY = 'bundled-seed' as const

/** The fixed manifest name included by the packaged bundled-seed resource. */
export const BUNDLED_SEED_MANIFEST_FILENAME = 'seed-manifest.json' as const

/** The single supported bundled-seed manifest tag. */
export const BUNDLED_SEED_FORMAT = 'dsh-launcher-bundled-seed' as const

/** The currently supported bundled-seed manifest revision. */
export const BUNDLED_SEED_VERSION = 1 as const

const BUNDLE_RELATIVE_PATH = 'harness/deepseek-harness.git.bundle' as const
const PLUGIN_PACKAGE_RELATIVE_PATH = 'plugins/package.json' as const
const PLUGIN_GENERATION_RELATIVE_PATH = 'plugins/generation.json' as const
const MAX_JSON_RESOURCE_BYTES = 1024 * 1024
// DeepSeek Harness ships `packages/bundle/web-app` and no desktop-app bundle,
// and the Launcher starts the ordinary `dsh web` command, so the seed contract
// names the bundles that actually exist.
const EXPECTED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/** Stable errors while loading the package-only bundled DSH seed. */
export type BundledSeedRuntimeErrorCode =
  | 'bundled_seed.unavailable'
  | 'bundled_seed.invalid'
  | 'bundled_seed.integrity_failed'

/** A non-secret failure proving that no valid bundled seed can be imported. */
export class BundledSeedRuntimeError extends Error {
  readonly code: BundledSeedRuntimeErrorCode
  readonly details: Readonly<Record<string, string | number | boolean>>

  constructor(
    code: BundledSeedRuntimeErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean>> = {}
  ) {
    super(message)
    this.name = 'BundledSeedRuntimeError'
    this.code = code
    this.details = details
  }
}

/** One hashed package resource verified before any seed import can begin. */
export interface VerifiedBundledSeedResource {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

/** The exact package manifest used to materialize the normal managed Plugins generation. */
export interface VerifiedBundledSeedPluginPackage {
  readonly path: string
  readonly contents: string
  readonly sha256: string
  readonly bytes: number
  readonly name: 'dsh-web-plugin-generation'
  readonly private: true
  readonly type: 'module'
}

/** The exact plugin-generation metadata tied to the bundled Harness revision. */
export interface VerifiedBundledSeedPluginGeneration {
  readonly path: string
  readonly contents: string
  readonly sha256: string
  readonly bytes: number
  readonly format: 'dsh-launcher-plugin-generation'
  readonly version: 1
  readonly generationId: string
  readonly harnessRevision: string
  readonly resolution: 'selected-harness-worktree'
  readonly bundles: readonly ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  readonly identity: string
}

/** Immutable package facts required to import the seed through the normal managed-installation path. */
export interface VerifiedBundledSeed {
  readonly rootPath: string
  readonly remoteUrl: string
  readonly revision: string
  readonly bundlePath: string
  readonly bundle: VerifiedBundledSeedResource
  readonly resources: readonly VerifiedBundledSeedResource[]
  readonly plugins: Readonly<{
    directoryPath: string
    packageManifest: VerifiedBundledSeedPluginPackage
    generationManifest: VerifiedBundledSeedPluginGeneration
  }>
}

interface SeedManifest {
  readonly format: typeof BUNDLED_SEED_FORMAT
  readonly version: typeof BUNDLED_SEED_VERSION
  readonly remoteUrl: string
  readonly harness: Readonly<{
    revision: string
    objectFormat: 'sha1'
    bundlePath: typeof BUNDLE_RELATIVE_PATH
    bundleSha256: string
    bundleBytes: number
  }>
  readonly pluginGeneration: Readonly<{
    generationId: string
    identity: string
    resourcePath: 'plugins'
    packageManifestPath: typeof PLUGIN_PACKAGE_RELATIVE_PATH
    packageManifestSha256: string
    generationManifestPath: typeof PLUGIN_GENERATION_RELATIVE_PATH
    generationManifestSha256: string
    bundles: readonly ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  }>
  readonly resources: readonly VerifiedBundledSeedResource[]
}

interface PluginPackageManifest {
  readonly name: 'dsh-web-plugin-generation'
  readonly private: true
  readonly type: 'module'
}

interface PluginGenerationManifest {
  readonly format: 'dsh-launcher-plugin-generation'
  readonly version: 1
  readonly generationId: string
  readonly harnessRevision: string
  readonly resolution: 'selected-harness-worktree'
  readonly bundles: readonly ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
}

/**
 * Reads the one packaged seed location below `process.resourcesPath`.
 *
 * Development builds and packages without those exact verified resources deliberately return an
 * unavailable error; this function never searches the source tree, a Git checkout, or another
 * application directory.
 */
export async function loadVerifiedBundledSeed(): Promise<VerifiedBundledSeed> {
  const resourcesPath = requiredResourcesPath()
  const rootPath = nodePath.join(resourcesPath, BUNDLED_SEED_RESOURCE_DIRECTORY)
  await assertDirectDirectory(rootPath, 'Bundled seed directory')
  await assertExactChildren(rootPath, [BUNDLED_SEED_MANIFEST_FILENAME, 'harness', 'plugins'])

  const manifestPath = nodePath.join(rootPath, BUNDLED_SEED_MANIFEST_FILENAME)
  const manifestSource = await readDirectText(manifestPath, 'Bundled seed manifest')
  const manifest = parseSeedManifest(parseJson(manifestSource.contents, 'Bundled seed manifest'))

  const harnessDirectory = nodePath.join(rootPath, 'harness')
  const pluginsDirectory = nodePath.join(rootPath, 'plugins')
  await Promise.all([
    assertDirectDirectory(harnessDirectory, 'Bundled Harness resource directory'),
    assertDirectDirectory(pluginsDirectory, 'Bundled plugin resource directory')
  ])
  await Promise.all([
    assertExactChildren(harnessDirectory, ['deepseek-harness.git.bundle']),
    assertExactChildren(pluginsDirectory, ['generation.json', 'package.json'])
  ])

  const resources = await Promise.all(
    [BUNDLE_RELATIVE_PATH, PLUGIN_PACKAGE_RELATIVE_PATH, PLUGIN_GENERATION_RELATIVE_PATH].map(
      (relativePath) => inspectResource(rootPath, relativePath)
    )
  )
  assertExactResourceList(manifest.resources, resources)

  const [packageSource, generationSource] = await Promise.all([
    readDirectText(
      resolveResourcePath(rootPath, PLUGIN_PACKAGE_RELATIVE_PATH),
      'Bundled plugin package manifest'
    ),
    readDirectText(
      resolveResourcePath(rootPath, PLUGIN_GENERATION_RELATIVE_PATH),
      'Bundled plugin generation manifest'
    )
  ])
  const packageManifest = parsePluginPackageManifest(
    parseJson(packageSource.contents, 'Bundled plugin package manifest')
  )
  const generationManifest = parsePluginGenerationManifest(
    parseJson(generationSource.contents, 'Bundled plugin generation manifest'),
    manifest.harness.revision
  )
  assertManifestResourceBindings(
    manifest,
    resources,
    generationManifest,
    packageSource,
    generationSource
  )

  const bundle = resources[0]
  const pluginPackage = resources[1]
  const pluginGeneration = resources[2]
  const verified: VerifiedBundledSeed = {
    rootPath,
    remoteUrl: manifest.remoteUrl,
    revision: manifest.harness.revision,
    bundlePath: resolveResourcePath(rootPath, BUNDLE_RELATIVE_PATH),
    bundle,
    resources,
    plugins: {
      directoryPath: pluginsDirectory,
      packageManifest: {
        path: resolveResourcePath(rootPath, PLUGIN_PACKAGE_RELATIVE_PATH),
        contents: packageSource.contents,
        sha256: pluginPackage.sha256,
        bytes: pluginPackage.bytes,
        ...packageManifest
      },
      generationManifest: {
        path: resolveResourcePath(rootPath, PLUGIN_GENERATION_RELATIVE_PATH),
        contents: generationSource.contents,
        sha256: pluginGeneration.sha256,
        bytes: pluginGeneration.bytes,
        ...generationManifest,
        identity: manifest.pluginGeneration.identity
      }
    }
  }
  return deepFreeze(verified)
}

function requiredResourcesPath(): string {
  const resourcesPath = process.resourcesPath
  if (
    typeof resourcesPath !== 'string' ||
    resourcesPath.length === 0 ||
    resourcesPath.includes('\u0000') ||
    !nodePath.isAbsolute(resourcesPath) ||
    nodePath.normalize(resourcesPath) !== resourcesPath ||
    nodePath.parse(resourcesPath).root === resourcesPath
  ) {
    throw unavailable('Electron process.resourcesPath does not provide a packaged bundled seed.')
  }
  return resourcesPath
}

function parseSeedManifest(value: unknown): SeedManifest {
  const manifest = exactObject(
    value,
    ['format', 'version', 'remoteUrl', 'harness', 'pluginGeneration', 'resources'],
    'Bundled seed manifest'
  )
  if (manifest.format !== BUNDLED_SEED_FORMAT || manifest.version !== BUNDLED_SEED_VERSION) {
    throw invalid('Bundled seed manifest format is unsupported.')
  }
  assertRemoteUrl(manifest.remoteUrl)
  const harness = exactObject(
    manifest.harness,
    ['revision', 'objectFormat', 'bundlePath', 'bundleSha256', 'bundleBytes'],
    'Bundled Harness record'
  )
  assertCommit(harness.revision, 'Bundled Harness revision')
  if (harness.objectFormat !== 'sha1' || harness.bundlePath !== BUNDLE_RELATIVE_PATH) {
    throw invalid('Bundled Harness record is invalid.')
  }
  assertSha256(harness.bundleSha256, 'Bundled Harness bundle hash')
  assertByteLength(harness.bundleBytes, 'Bundled Harness bundle length')

  const pluginGeneration = exactObject(
    manifest.pluginGeneration,
    [
      'generationId',
      'identity',
      'resourcePath',
      'packageManifestPath',
      'packageManifestSha256',
      'generationManifestPath',
      'generationManifestSha256',
      'bundles'
    ],
    'Bundled plugin generation record'
  )
  assertOpaqueId(pluginGeneration.generationId, 'Bundled plugin generation id')
  assertSha256(pluginGeneration.identity, 'Bundled plugin generation identity')
  if (
    pluginGeneration.resourcePath !== 'plugins' ||
    pluginGeneration.packageManifestPath !== PLUGIN_PACKAGE_RELATIVE_PATH ||
    pluginGeneration.generationManifestPath !== PLUGIN_GENERATION_RELATIVE_PATH
  ) {
    throw invalid('Bundled plugin generation resource paths are invalid.')
  }
  assertSha256(pluginGeneration.packageManifestSha256, 'Bundled plugin package manifest hash')
  assertSha256(pluginGeneration.generationManifestSha256, 'Bundled plugin generation manifest hash')
  const bundles = parseExpectedBundles(
    pluginGeneration.bundles,
    'Bundled plugin generation bundles'
  )

  if (!Array.isArray(manifest.resources)) {
    throw invalid('Bundled seed resources must be an array.')
  }
  const resources = manifest.resources.map((resource) => parseResourceRecord(resource))
  return {
    format: BUNDLED_SEED_FORMAT,
    version: BUNDLED_SEED_VERSION,
    remoteUrl: manifest.remoteUrl,
    harness: {
      revision: harness.revision,
      objectFormat: 'sha1',
      bundlePath: BUNDLE_RELATIVE_PATH,
      bundleSha256: harness.bundleSha256,
      bundleBytes: harness.bundleBytes
    },
    pluginGeneration: {
      generationId: pluginGeneration.generationId,
      identity: pluginGeneration.identity,
      resourcePath: 'plugins',
      packageManifestPath: PLUGIN_PACKAGE_RELATIVE_PATH,
      packageManifestSha256: pluginGeneration.packageManifestSha256,
      generationManifestPath: PLUGIN_GENERATION_RELATIVE_PATH,
      generationManifestSha256: pluginGeneration.generationManifestSha256,
      bundles
    },
    resources
  }
}

function parseResourceRecord(value: unknown): VerifiedBundledSeedResource {
  const resource = exactObject(value, ['path', 'sha256', 'bytes'], 'Bundled seed resource')
  assertResourcePath(resource.path, 'Bundled seed resource path')
  assertSha256(resource.sha256, 'Bundled seed resource hash')
  assertByteLength(resource.bytes, 'Bundled seed resource length')
  return { path: resource.path, sha256: resource.sha256, bytes: resource.bytes }
}

function parsePluginPackageManifest(value: unknown): PluginPackageManifest {
  const manifest = exactObject(
    value,
    ['name', 'private', 'type'],
    'Bundled plugin package manifest'
  )
  if (
    manifest.name !== 'dsh-web-plugin-generation' ||
    manifest.private !== true ||
    manifest.type !== 'module'
  ) {
    throw invalid('Bundled plugin package manifest is invalid.')
  }
  return {
    name: 'dsh-web-plugin-generation',
    private: true,
    type: 'module'
  }
}

function parsePluginGenerationManifest(value: unknown, revision: string): PluginGenerationManifest {
  const manifest = exactObject(
    value,
    ['format', 'version', 'generationId', 'harnessRevision', 'resolution', 'bundles'],
    'Bundled plugin generation manifest'
  )
  if (
    manifest.format !== 'dsh-launcher-plugin-generation' ||
    manifest.version !== 1 ||
    manifest.generationId !== `bundled-${revision}` ||
    manifest.harnessRevision !== revision ||
    manifest.resolution !== 'selected-harness-worktree'
  ) {
    throw invalid('Bundled plugin generation manifest is invalid.')
  }
  return {
    format: 'dsh-launcher-plugin-generation',
    version: 1,
    generationId: manifest.generationId,
    harnessRevision: revision,
    resolution: 'selected-harness-worktree',
    bundles: parseExpectedBundles(manifest.bundles, 'Bundled plugin generation manifest bundles')
  }
}

function assertManifestResourceBindings(
  manifest: SeedManifest,
  resources: readonly VerifiedBundledSeedResource[],
  generation: PluginGenerationManifest,
  packageSource: Readonly<{ contents: string; bytes: number; sha256: string }>,
  generationSource: Readonly<{ contents: string; bytes: number; sha256: string }>
): void {
  const [bundle, pluginPackage, pluginGeneration] = resources
  if (
    manifest.harness.bundleSha256 !== bundle.sha256 ||
    manifest.harness.bundleBytes !== bundle.bytes ||
    manifest.pluginGeneration.packageManifestSha256 !== pluginPackage.sha256 ||
    manifest.pluginGeneration.generationManifestSha256 !== pluginGeneration.sha256 ||
    packageSource.sha256 !== pluginPackage.sha256 ||
    generationSource.sha256 !== pluginGeneration.sha256 ||
    manifest.pluginGeneration.generationId !== generation.generationId ||
    manifest.pluginGeneration.identity !==
      pluginGenerationIdentity(generation, pluginPackage.sha256)
  ) {
    throw integrityFailed('Bundled seed manifest does not match its verified resources.')
  }
}

function assertExactResourceList(
  declared: readonly VerifiedBundledSeedResource[],
  actual: readonly VerifiedBundledSeedResource[]
): void {
  if (
    declared.length !== actual.length ||
    declared.some(
      (resource, index) =>
        resource.path !== actual[index]?.path ||
        resource.sha256 !== actual[index]?.sha256 ||
        resource.bytes !== actual[index]?.bytes
    )
  ) {
    throw integrityFailed('Bundled seed resource list does not match the packaged files.')
  }
}

async function inspectResource(
  rootPath: string,
  relativePath: (typeof expectedResourcePaths)[number]
): Promise<VerifiedBundledSeedResource> {
  const resourcePath = resolveResourcePath(rootPath, relativePath)
  const before = await assertDirectRegularFile(
    resourcePath,
    `Bundled seed resource ${relativePath}`
  )
  let sha256: string
  try {
    sha256 = await sha256File(resourcePath)
  } catch (error) {
    if (error instanceof BundledSeedRuntimeError) throw error
    throw unavailable(`Bundled seed resource ${relativePath} is unavailable.`, error)
  }
  const after = await assertDirectRegularFile(resourcePath, `Bundled seed resource ${relativePath}`)
  if (!sameFile(before, after)) {
    throw invalid(`Bundled seed resource ${relativePath} changed while being verified.`)
  }
  return { path: relativePath, sha256, bytes: numericByteSize(after, relativePath) }
}

const expectedResourcePaths = [
  BUNDLE_RELATIVE_PATH,
  PLUGIN_PACKAGE_RELATIVE_PATH,
  PLUGIN_GENERATION_RELATIVE_PATH
] as const

async function readDirectText(
  resourcePath: string,
  label: string
): Promise<Readonly<{ contents: string; bytes: number; sha256: string }>> {
  const before = await assertDirectRegularFile(resourcePath, label)
  if (numericByteSize(before, label) > MAX_JSON_RESOURCE_BYTES) {
    throw invalid(`${label} exceeds the supported size.`)
  }
  let rawContents: Buffer
  try {
    rawContents = await readFile(resourcePath)
  } catch (error) {
    throw unavailable(`${label} is unavailable.`, error)
  }
  const after = await assertDirectRegularFile(resourcePath, label)
  if (!sameFile(before, after) || rawContents.byteLength !== numericByteSize(after, label)) {
    throw invalid(`${label} changed while being read.`)
  }
  return Object.freeze({
    contents: rawContents.toString('utf8'),
    bytes: numericByteSize(after, label),
    sha256: createHash('sha256').update(rawContents).digest('hex')
  })
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw invalid(`${label} is not valid JSON.`)
  }
}

async function assertDirectDirectory(directoryPath: string, label: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(directoryPath)
  } catch (error) {
    throw unavailable(`${label} is unavailable.`, error)
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw invalid(`${label} must be a direct directory.`)
  }
}

async function assertExactChildren(
  directoryPath: string,
  expectedNames: readonly string[]
): Promise<void> {
  let actual: string[]
  try {
    actual = (await readdir(directoryPath, { withFileTypes: true }))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    throw unavailable('Bundled seed directory contents are unavailable.', error)
  }
  const expected = [...expectedNames].sort()
  const missing = expected.filter((name) => !actual.includes(name))
  if (missing.length > 0) {
    throw unavailable('Bundled seed directory is missing a required resource.')
  }
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw invalid('Bundled seed directory contains unexpected or missing resources.')
  }
}

async function assertDirectRegularFile(
  resourcePath: string,
  label: string
): Promise<Awaited<ReturnType<typeof lstat>>> {
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(resourcePath)
  } catch (error) {
    throw unavailable(`${label} is unavailable.`, error)
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw invalid(`${label} must be a direct regular file.`)
  }
  return metadata
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be an object.`)
  }
  const actualKeys = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    throw invalid(`${label} contains unexpected fields.`)
  }
  return value as Record<string, unknown>
}

function parseExpectedBundles(
  value: unknown,
  label: string
): readonly ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] {
  if (
    !Array.isArray(value) ||
    value.length !== EXPECTED_BUNDLES.length ||
    value.some((entry, index) => entry !== EXPECTED_BUNDLES[index])
  ) {
    throw invalid(`${label} are invalid.`)
  }
  return [EXPECTED_BUNDLES[0], EXPECTED_BUNDLES[1]]
}

function assertRemoteUrl(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw invalid('Bundled Harness remote URL is invalid.')
  }
  if (/\s|[\u0000-\u001f\\]|[%#?]/u.test(value) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(value)) {
    throw invalid('Bundled Harness remote URL is invalid.')
  }
  if (/^(?:https|ssh):\/\//u.test(value)) {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw invalid('Bundled Harness remote URL is invalid.')
    }
    if (
      !parsed.hostname ||
      parsed.password ||
      parsed.hash ||
      parsed.search ||
      (parsed.protocol === 'https:' && parsed.username)
    ) {
      throw invalid('Bundled Harness remote URL is invalid.')
    }
    return
  }
  if (!/^(?:[A-Za-z_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9.-]+:.+$/u.test(value)) {
    throw invalid('Bundled Harness remote URL must use HTTPS or SSH.')
  }
}

function assertCommit(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    throw invalid(`${label} must be a full lowercase Git SHA-1.`)
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw invalid(`${label} must be a SHA-256 digest.`)
  }
}

function assertByteLength(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${label} must be a non-negative byte length.`)
  }
}

function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw invalid(`${label} is invalid.`)
  }
}

function assertResourcePath(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._@/-]*$/u.test(value) ||
    value.includes('//') ||
    value.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw invalid(`${label} is invalid.`)
  }
}

function resolveResourcePath(rootPath: string, relativePath: string): string {
  const resolved = nodePath.resolve(rootPath, relativePath)
  const relation = nodePath.relative(rootPath, resolved)
  if (
    relation === '' ||
    relation === '..' ||
    relation.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(relation)
  ) {
    throw invalid('Bundled seed resource path escapes the packaged seed directory.')
  }
  return resolved
}

function pluginGenerationIdentity(
  generation: PluginGenerationManifest,
  packageManifestSha256: string
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        format: generation.format,
        version: generation.version,
        generationId: generation.generationId,
        harnessRevision: generation.harnessRevision,
        resolution: generation.resolution,
        bundles: generation.bundles,
        packageManifestSha256
      }),
      'utf8'
    )
    .digest('hex')
}

function sha256File(resourcePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(resourcePath)
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk)
    })
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

function sameFile(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  )
}

function numericByteSize(metadata: Awaited<ReturnType<typeof lstat>>, label: string): number {
  if (typeof metadata.size !== 'number') {
    throw invalid(`${label} reports an unsupported byte length.`)
  }
  return metadata.size
}

function unavailable(message: string, cause?: unknown): BundledSeedRuntimeError {
  return new BundledSeedRuntimeError('bundled_seed.unavailable', message, {
    ...(cause === undefined ? {} : { cause: cause instanceof Error ? cause.name : 'unknown' })
  })
}

function invalid(message: string): BundledSeedRuntimeError {
  return new BundledSeedRuntimeError('bundled_seed.invalid', message)
}

function integrityFailed(message: string): BundledSeedRuntimeError {
  return new BundledSeedRuntimeError('bundled_seed.integrity_failed', message)
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
