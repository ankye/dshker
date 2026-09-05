import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resourcesRoot = path.join(appRoot, 'resources', 'bundled-seed')
export const bundledSeedStagingDirectory = path.join(resourcesRoot, 'staged')
export const BUNDLED_SEED_MANIFEST_FILENAME = 'seed-manifest.json'
export const BUNDLED_SEED_FORMAT = 'dsh-launcher-bundled-seed'
export const BUNDLED_SEED_VERSION = 1

const BUNDLE_RELATIVE_PATH = 'harness/deepseek-harness.git.bundle'
const PLUGIN_PACKAGE_RELATIVE_PATH = 'plugins/package.json'
const PLUGIN_GENERATION_RELATIVE_PATH = 'plugins/generation.json'
// DeepSeek Harness ships `packages/bundle/web-app`; there is no desktop-app
// bundle. The Launcher starts the ordinary `dsh web` command, so the seed is
// validated against the bundles that actually exist in the checkout.
const EXPECTED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const GIT_TIMEOUT_MILLISECONDS = 10 * 60 * 1000

/** Error with a stable code for a release-blocking bundled-seed failure. */
export class BundledSeedError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BundledSeedError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

/** Reads the only supported explicit release inputs. No source or Git executable is discovered from ambient state. */
export function readBundledSeedBuildInputs(environment = process.env) {
  const sourceDirectory = requiredEnvironmentValue(environment, 'DSH_BUNDLED_HARNESS_SOURCE')
  const remoteUrl = requiredEnvironmentValue(environment, 'DSH_BUNDLED_HARNESS_REMOTE_URL')
  const gitExecutable = requiredEnvironmentValue(environment, 'DSH_BUNDLED_GIT_EXECUTABLE')
  assertCanonicalAbsolutePath(sourceDirectory, 'DSH_BUNDLED_HARNESS_SOURCE')
  assertCanonicalAbsolutePath(gitExecutable, 'DSH_BUNDLED_GIT_EXECUTABLE')
  assertRemoteUrl(remoteUrl)
  return Object.freeze({ sourceDirectory, remoteUrl, gitExecutable })
}

/** Builds one portable, read-only seed from a clean DSH checkout and its declared origin. */
export async function prepareBundledSeed({
  sourceDirectory,
  remoteUrl,
  gitExecutable,
  outputDirectory = bundledSeedStagingDirectory
}) {
  assertCanonicalAbsolutePath(sourceDirectory, 'Bundled Harness source')
  assertCanonicalAbsolutePath(gitExecutable, 'Bundled Git executable')
  assertRemoteUrl(remoteUrl)
  await assertDirectDirectory(sourceDirectory, 'Bundled Harness source')
  await assertRegularExecutable(gitExecutable, 'Bundled Git executable')

  const source = await inspectBundledHarnessSource({ sourceDirectory, remoteUrl, gitExecutable })
  await resetSeedOutputDirectory(outputDirectory)
  const harnessDirectory = path.join(outputDirectory, 'harness')
  const pluginDirectory = path.join(outputDirectory, 'plugins')
  await Promise.all([mkdir(harnessDirectory), mkdir(pluginDirectory)])

  const bundlePath = path.join(outputDirectory, BUNDLE_RELATIVE_PATH)
  const temporaryBundlePath = path.join(
    harnessDirectory,
    `.dsh-${source.revision}-${randomUUID()}.git.bundle`
  )
  try {
    await runGit(gitExecutable, sourceDirectory, [
      'bundle',
      'create',
      temporaryBundlePath,
      source.bundleReference
    ])
    await runGit(gitExecutable, sourceDirectory, ['bundle', 'verify', temporaryBundlePath])
    const bundleHeads = await runGit(gitExecutable, sourceDirectory, [
      'bundle',
      'list-heads',
      temporaryBundlePath
    ])
    if (!bundleListsExactRevision(bundleHeads, source.revision, source.bundleReference)) {
      throw new BundledSeedError(
        'seed.git_failed',
        'Bundled Harness Git bundle does not expose the requested exact revision.'
      )
    }
    await rename(temporaryBundlePath, bundlePath)

    const pluginPackage = pluginPackageManifest()
    const generationId = `bundled-${source.revision}`
    const pluginGeneration = pluginGenerationManifest(generationId, source.revision)
    const pluginPackagePath = path.join(outputDirectory, PLUGIN_PACKAGE_RELATIVE_PATH)
    const pluginGenerationPath = path.join(outputDirectory, PLUGIN_GENERATION_RELATIVE_PATH)
    await writeNewJson(pluginPackagePath, pluginPackage)
    await writeNewJson(pluginGenerationPath, pluginGeneration)

    const [bundle, pluginPackageResource, pluginGenerationResource] = await Promise.all([
      resourceRecord(outputDirectory, BUNDLE_RELATIVE_PATH),
      resourceRecord(outputDirectory, PLUGIN_PACKAGE_RELATIVE_PATH),
      resourceRecord(outputDirectory, PLUGIN_GENERATION_RELATIVE_PATH)
    ])
    const manifest = {
      format: BUNDLED_SEED_FORMAT,
      version: BUNDLED_SEED_VERSION,
      remoteUrl,
      harness: {
        revision: source.revision,
        objectFormat: 'sha1',
        bundlePath: BUNDLE_RELATIVE_PATH,
        bundleSha256: bundle.sha256,
        bundleBytes: bundle.bytes
      },
      pluginGeneration: {
        generationId,
        identity: pluginGenerationIdentity(pluginGeneration, pluginPackageResource.sha256),
        resourcePath: 'plugins',
        packageManifestPath: PLUGIN_PACKAGE_RELATIVE_PATH,
        packageManifestSha256: pluginPackageResource.sha256,
        generationManifestPath: PLUGIN_GENERATION_RELATIVE_PATH,
        generationManifestSha256: pluginGenerationResource.sha256,
        bundles: [...EXPECTED_BUNDLES]
      },
      resources: [bundle, pluginPackageResource, pluginGenerationResource]
    }
    await writeNewJson(path.join(outputDirectory, BUNDLED_SEED_MANIFEST_FILENAME), manifest)
    const verified = await verifyBundledSeedDirectory(outputDirectory)
    return Object.freeze({ directory: outputDirectory, manifest: verified.manifest })
  } catch (error) {
    try {
      await removeSeedOutputDirectory(outputDirectory)
    } catch (cleanupError) {
      // A Windows runner may briefly hold a generated bundle while the
      // original Git/build error is being handled. Preserve the original
      // release-blocking error so cleanup cannot mask its cause.
      if (process.platform !== 'win32') throw cleanupError
    }
    throw error
  }
}

/** Reads and validates every seed fact that a Launcher import implementation must trust. */
export async function verifyBundledSeedDirectory(directory = bundledSeedStagingDirectory) {
  assertCanonicalAbsolutePath(directory, 'Bundled seed directory')
  await assertDirectDirectory(directory, 'Bundled seed directory')
  await assertExactChildren(directory, [BUNDLED_SEED_MANIFEST_FILENAME, 'harness', 'plugins'])
  const manifestPath = path.join(directory, BUNDLED_SEED_MANIFEST_FILENAME)
  await assertDirectRegularFile(manifestPath, 'Bundled seed manifest')
  const manifest = await readJson(manifestPath, 'Bundled seed manifest')
  assertBundledSeedManifest(manifest)

  const harnessDirectory = path.join(directory, 'harness')
  const pluginDirectory = path.join(directory, 'plugins')
  await Promise.all([
    assertDirectDirectory(harnessDirectory, 'Bundled Harness resource directory'),
    assertDirectDirectory(pluginDirectory, 'Bundled plugin resource directory'),
    assertExactChildren(harnessDirectory, ['deepseek-harness.git.bundle']),
    assertExactChildren(pluginDirectory, ['generation.json', 'package.json'])
  ])

  const expectedResources = [
    BUNDLE_RELATIVE_PATH,
    PLUGIN_PACKAGE_RELATIVE_PATH,
    PLUGIN_GENERATION_RELATIVE_PATH
  ]
  if (
    manifest.resources.length !== expectedResources.length ||
    manifest.resources.some((resource, index) => resource.path !== expectedResources[index])
  ) {
    throw new BundledSeedError('seed.resources_invalid', 'Bundled seed resource list is not exact.')
  }
  const actualResources = await Promise.all(
    expectedResources.map((relativePath) => resourceRecord(directory, relativePath))
  )
  for (const [index, expected] of manifest.resources.entries()) {
    const actual = actualResources[index]
    if (expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) {
      throw new BundledSeedError(
        'seed.resource_integrity_failed',
        'Bundled seed resource hash mismatch.',
        {
          path: expected.path
        }
      )
    }
  }

  const [pluginPackage, pluginGeneration] = await Promise.all([
    readJson(path.join(directory, PLUGIN_PACKAGE_RELATIVE_PATH), 'Bundled plugin package manifest'),
    readJson(
      path.join(directory, PLUGIN_GENERATION_RELATIVE_PATH),
      'Bundled plugin generation manifest'
    )
  ])
  assertPluginPackageManifest(pluginPackage)
  assertPluginGenerationManifest(pluginGeneration, manifest.harness.revision)
  const pluginPackageResource = actualResources[1]
  const pluginGenerationResource = actualResources[2]
  if (
    manifest.harness.bundlePath !== BUNDLE_RELATIVE_PATH ||
    manifest.harness.bundleSha256 !== actualResources[0].sha256 ||
    manifest.harness.bundleBytes !== actualResources[0].bytes ||
    manifest.pluginGeneration.resourcePath !== 'plugins' ||
    manifest.pluginGeneration.packageManifestPath !== PLUGIN_PACKAGE_RELATIVE_PATH ||
    manifest.pluginGeneration.packageManifestSha256 !== pluginPackageResource.sha256 ||
    manifest.pluginGeneration.generationManifestPath !== PLUGIN_GENERATION_RELATIVE_PATH ||
    manifest.pluginGeneration.generationManifestSha256 !== pluginGenerationResource.sha256 ||
    manifest.pluginGeneration.generationId !== pluginGeneration.generationId ||
    manifest.pluginGeneration.identity !==
      pluginGenerationIdentity(pluginGeneration, pluginPackageResource.sha256)
  ) {
    throw new BundledSeedError(
      'seed.manifest_mismatch',
      'Bundled seed manifest does not match its resources.'
    )
  }

  return Object.freeze({ directory, manifest: deepFreeze(manifest) })
}

/** Validates the exact public seed document without relying on a permissive JSON-schema implementation. */
export function assertBundledSeedManifest(value) {
  const manifest = exactObject(
    value,
    ['format', 'version', 'remoteUrl', 'harness', 'pluginGeneration', 'resources'],
    'Bundled seed manifest'
  )
  if (manifest.format !== BUNDLED_SEED_FORMAT || manifest.version !== BUNDLED_SEED_VERSION) {
    throw new BundledSeedError(
      'seed.manifest_invalid',
      'Bundled seed manifest format is unsupported.'
    )
  }
  assertRemoteUrl(manifest.remoteUrl)
  const harness = exactObject(
    manifest.harness,
    ['revision', 'objectFormat', 'bundlePath', 'bundleSha256', 'bundleBytes'],
    'Bundled Harness record'
  )
  assertCommit(harness.revision, 'Bundled Harness revision')
  if (harness.objectFormat !== 'sha1') {
    throw new BundledSeedError(
      'seed.manifest_invalid',
      'Bundled Harness object format must be sha1.'
    )
  }
  assertResourcePath(harness.bundlePath, 'Bundled Harness bundle path')
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
  assertResourcePath(pluginGeneration.resourcePath, 'Bundled plugin resource path')
  assertResourcePath(pluginGeneration.packageManifestPath, 'Bundled plugin package manifest path')
  assertSha256(pluginGeneration.packageManifestSha256, 'Bundled plugin package manifest hash')
  assertResourcePath(
    pluginGeneration.generationManifestPath,
    'Bundled plugin generation manifest path'
  )
  assertSha256(pluginGeneration.generationManifestSha256, 'Bundled plugin generation manifest hash')
  assertExpectedBundles(pluginGeneration.bundles, 'Bundled plugin generation bundles')

  if (!Array.isArray(manifest.resources)) {
    throw new BundledSeedError('seed.manifest_invalid', 'Bundled seed resources must be an array.')
  }
  for (const resource of manifest.resources) {
    const record = exactObject(resource, ['path', 'sha256', 'bytes'], 'Bundled seed resource')
    assertResourcePath(record.path, 'Bundled seed resource path')
    assertSha256(record.sha256, 'Bundled seed resource hash')
    assertByteLength(record.bytes, 'Bundled seed resource length')
  }
}

/** Returns one source fact set only after the explicit checkout and origin agree with the requested release inputs. */
export async function inspectBundledHarnessSource({ sourceDirectory, remoteUrl, gitExecutable }) {
  const [
    insideWorkTree,
    topLevel,
    status,
    revision,
    objectFormat,
    observedRemote,
    bundleReference
  ] = await Promise.all([
    runGit(gitExecutable, sourceDirectory, ['rev-parse', '--is-inside-work-tree']),
    runGit(gitExecutable, sourceDirectory, ['rev-parse', '--show-toplevel']),
    runGit(gitExecutable, sourceDirectory, ['status', '--porcelain=v1', '--untracked-files=no']),
    runGit(gitExecutable, sourceDirectory, ['rev-parse', 'HEAD']),
    runGit(gitExecutable, sourceDirectory, ['rev-parse', '--show-object-format']),
    runGit(gitExecutable, sourceDirectory, ['remote', 'get-url', 'origin']),
    runGit(gitExecutable, sourceDirectory, ['symbolic-ref', '--quiet', 'HEAD'])
  ])
  if (insideWorkTree !== 'true' || !(await sameCanonicalDirectory(topLevel, sourceDirectory))) {
    throw new BundledSeedError(
      'seed.source_invalid',
      'DSH_BUNDLED_HARNESS_SOURCE must be a Git checkout root.'
    )
  }
  if (status !== '') {
    throw new BundledSeedError(
      'seed.source_dirty',
      'DSH_BUNDLED_HARNESS_SOURCE has tracked changes and cannot produce an exact seed.'
    )
  }
  assertCommit(revision, 'Bundled Harness source revision')
  if (objectFormat !== 'sha1') {
    throw new BundledSeedError(
      'seed.source_invalid',
      'Bundled Harness source must use Git SHA-1 objects.'
    )
  }
  if (observedRemote !== remoteUrl) {
    throw new BundledSeedError(
      'seed.remote_mismatch',
      'DSH_BUNDLED_HARNESS_REMOTE_URL must exactly match the source checkout origin.'
    )
  }
  if (
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(bundleReference) ||
    bundleReference.includes('//') ||
    bundleReference.includes('..') ||
    bundleReference.endsWith('/')
  ) {
    throw new BundledSeedError(
      'seed.source_invalid',
      'Bundled Harness source must have a checked-out local branch for the portable Git bundle.'
    )
  }
  await assertDshSourceLayout(sourceDirectory)
  return Object.freeze({ revision, remoteUrl, bundleReference })
}

function pluginPackageManifest() {
  return {
    name: 'dsh-web-plugin-generation',
    private: true,
    type: 'module'
  }
}

function bundleListsExactRevision(output, revision, reference) {
  return output.split(/\r?\n/u).some((line) => line === `${revision} ${reference}`)
}

function pluginGenerationManifest(generationId, harnessRevision) {
  return {
    format: 'dsh-launcher-plugin-generation',
    version: 1,
    generationId,
    harnessRevision,
    resolution: 'selected-harness-worktree',
    bundles: [...EXPECTED_BUNDLES]
  }
}

function pluginGenerationIdentity(generation, packageManifestSha256) {
  return sha256Text(
    JSON.stringify({
      format: generation.format,
      version: generation.version,
      generationId: generation.generationId,
      harnessRevision: generation.harnessRevision,
      resolution: generation.resolution,
      bundles: generation.bundles,
      packageManifestSha256
    })
  )
}

async function assertDshSourceLayout(sourceDirectory) {
  const requiredFiles = [
    'package.json',
    'pnpm-lock.yaml',
    'apps/cli/package.json',
    'apps/cli/src/bin.ts',
    'packages/bundle/base/package.json',
    'packages/bundle/web-app/package.json',
    'packages/bundle/web-app/cordis.patch.yml'
  ]
  await Promise.all(
    requiredFiles.map((relativePath) =>
      assertDirectRegularFile(
        path.join(sourceDirectory, relativePath),
        `DSH source ${relativePath}`
      )
    )
  )
  const [cliPackage, basePackage, webPackage] = await Promise.all([
    readJson(path.join(sourceDirectory, 'apps/cli/package.json'), 'DSH CLI package manifest'),
    readJson(
      path.join(sourceDirectory, 'packages/bundle/base/package.json'),
      'DSH base bundle manifest'
    ),
    readJson(
      path.join(sourceDirectory, 'packages/bundle/web-app/package.json'),
      'DSH web bundle manifest'
    )
  ])
  if (cliPackage.name !== '@deepseek-ai/dsh') {
    throw new BundledSeedError('seed.source_invalid', 'DSH source CLI package name is invalid.')
  }
  if (basePackage.name !== EXPECTED_BUNDLES[0] || webPackage.name !== EXPECTED_BUNDLES[1]) {
    throw new BundledSeedError(
      'seed.source_invalid',
      'DSH source bundle package names are invalid.'
    )
  }
  if (typeof cliPackage.dependencies?.[EXPECTED_BUNDLES[1]] !== 'string') {
    throw new BundledSeedError(
      'seed.source_invalid',
      'DSH CLI package must declare the web bundle dependency.'
    )
  }
}

async function resetSeedOutputDirectory(directory) {
  assertCanonicalAbsolutePath(directory, 'Bundled seed output directory')
  const canonicalParent = path.dirname(directory)
  await assertDirectDirectory(canonicalParent, 'Bundled seed output parent directory')
  try {
    const metadata = await lstat(directory)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new BundledSeedError(
        'seed.output_invalid',
        'Bundled seed output must be a direct directory when it already exists.'
      )
    }
    await rm(directory, { recursive: true, force: false, maxRetries: 30, retryDelay: 500 })
  } catch (error) {
    if (!isNodeCode(error, 'ENOENT')) throw error
  }
  await mkdir(directory)
  await assertDirectDirectory(directory, 'Bundled seed output directory')
}

async function removeSeedOutputDirectory(directory) {
  try {
    const metadata = await lstat(directory)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new BundledSeedError(
        'seed.output_invalid',
        'Partially generated bundled seed output is not a direct directory.'
      )
    }
    await rm(directory, { recursive: true, force: false, maxRetries: 30, retryDelay: 500 })
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return
    if (error instanceof BundledSeedError) throw error
    throw new BundledSeedError(
      'seed.cleanup_failed',
      'Partially generated bundled seed could not be removed.',
      {
        cause: error instanceof Error ? error.name : 'unknown'
      }
    )
  }
}

async function resourceRecord(root, relativePath) {
  assertResourcePath(relativePath, 'Bundled seed resource path')
  const filePath = resolveResourcePath(root, relativePath)
  await assertDirectRegularFile(filePath, `Bundled seed resource ${relativePath}`)
  const metadata = await stat(filePath)
  return Object.freeze({
    path: relativePath,
    sha256: await sha256File(filePath),
    bytes: metadata.size
  })
}

async function assertExactChildren(directory, expectedNames) {
  const actual = (await readdir(directory, { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort()
  const expected = [...expectedNames].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new BundledSeedError(
      'seed.resources_invalid',
      'Bundled seed directory contains unexpected entries.',
      {
        directory
      }
    )
  }
}

async function writeNewJson(filePath, value) {
  try {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
  } catch (error) {
    throw new BundledSeedError(
      'seed.output_write_failed',
      'Bundled seed resource could not be written.',
      {
        path: filePath,
        cause: error instanceof Error ? error.name : 'unknown'
      }
    )
  }
}

async function readJson(filePath, label) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new BundledSeedError('seed.resource_unavailable', `${label} is unavailable.`, {
      cause: error instanceof Error ? error.name : 'unknown'
    })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new BundledSeedError('seed.resource_invalid', `${label} is not valid JSON.`)
  }
}

async function assertDirectDirectory(directory, label) {
  let metadata
  try {
    metadata = await lstat(directory)
  } catch (error) {
    throw new BundledSeedError('seed.resource_unavailable', `${label} is unavailable.`, {
      cause: error instanceof Error ? error.name : 'unknown'
    })
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BundledSeedError('seed.resource_invalid', `${label} must be a direct directory.`)
  }
}

async function assertDirectRegularFile(filePath, label) {
  let metadata
  try {
    metadata = await lstat(filePath)
  } catch (error) {
    throw new BundledSeedError('seed.resource_unavailable', `${label} is unavailable.`, {
      cause: error instanceof Error ? error.name : 'unknown'
    })
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new BundledSeedError('seed.resource_invalid', `${label} must be a direct regular file.`)
  }
}

async function assertRegularExecutable(executable, label) {
  let canonicalPath
  try {
    canonicalPath = await realpath(executable)
    const metadata = await stat(canonicalPath)
    if (!metadata.isFile()) {
      throw new BundledSeedError('seed.input_invalid', `${label} must be a regular file.`)
    }
  } catch (error) {
    if (error instanceof BundledSeedError) throw error
    throw new BundledSeedError('seed.input_invalid', `${label} is unavailable.`, {
      cause: error instanceof Error ? error.name : 'unknown'
    })
  }
}

async function sameCanonicalDirectory(left, right) {
  try {
    return (await realpath(left)) === (await realpath(right))
  } catch (error) {
    throw new BundledSeedError(
      'seed.resource_unavailable',
      'Bundled Harness checkout cannot be resolved.',
      {
        cause: error instanceof Error ? error.name : 'unknown'
      }
    )
  }
}

async function runGit(executable, cwd, arguments_) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env }
    delete environment.GIT_DIR
    delete environment.GIT_WORK_TREE
    delete environment.GIT_CONFIG_KEY_0
    delete environment.GIT_CONFIG_VALUE_0
    environment.GIT_CONFIG_NOSYSTEM = '1'
    // An empty global-config path disables user config without asking Git for
    // the Windows `NUL` device, which ARM Git builds reject as a file path.
    environment.GIT_CONFIG_GLOBAL = ''
    environment.GIT_CONFIG_COUNT = '0'
    environment.GIT_TERMINAL_PROMPT = '0'
    environment.GIT_OPTIONAL_LOCKS = '0'
    let child
    try {
      child = spawn(executable, ['-C', cwd, ...arguments_], {
        cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(
        new BundledSeedError('seed.git_failed', 'Bundled seed Git command could not start.', {
          cause: error instanceof Error ? error.name : 'unknown'
        })
      )
      return
    }
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let complete = false
    let timeout
    const finish = (error, value) => {
      if (complete) return
      complete = true
      if (timeout !== undefined) clearTimeout(timeout)
      if (error) reject(error)
      else resolve(value)
    }
    const append = (target, chunk) => {
      const text = String(chunk)
      bytes += Buffer.byteLength(text, 'utf8')
      if (bytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill('SIGTERM')
        finish(
          new BundledSeedError(
            'seed.git_failed',
            'Bundled seed Git command exceeded its output limit.'
          )
        )
        return
      }
      if (target === 'stdout') stdout += text
      else stderr += text
    }
    child.stdout.on('data', (chunk) => append('stdout', chunk))
    child.stderr.on('data', (chunk) => append('stderr', chunk))
    child.once('error', (error) => {
      finish(
        new BundledSeedError('seed.git_failed', 'Bundled seed Git command failed to run.', {
          cause: error instanceof Error ? error.name : 'unknown'
        })
      )
    })
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) {
        finish(undefined, stdout.trim())
        return
      }
      finish(
        new BundledSeedError('seed.git_failed', 'Bundled seed Git command failed.', {
          operation: arguments_.join(' '),
          exitCode: code ?? -1,
          signal: signal ?? 'none',
          stderr: stderr.trim().slice(-512)
        })
      )
    })
    timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new BundledSeedError('seed.git_failed', 'Bundled seed Git command timed out.'))
    }, GIT_TIMEOUT_MILLISECONDS)
  })
}

function requiredEnvironmentValue(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BundledSeedError(
      'seed.input_missing',
      `${name} is required to prepare a bundled DSH seed.`
    )
  }
  return value
}

function assertCanonicalAbsolutePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new BundledSeedError(
      'seed.input_invalid',
      `${label} must be a canonical non-root absolute path.`
    )
  }
}

function assertRemoteUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new BundledSeedError('seed.remote_invalid', 'Bundled Harness remote URL is required.')
  }
  if (/\s|[\u0000-\u001f\\]|[%#?]/u.test(value) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(value)) {
    throw new BundledSeedError('seed.remote_invalid', 'Bundled Harness remote URL is invalid.')
  }
  if (/^(?:https|ssh):\/\//u.test(value)) {
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      throw new BundledSeedError('seed.remote_invalid', 'Bundled Harness remote URL is invalid.')
    }
    if (
      !parsed.hostname ||
      parsed.password ||
      parsed.hash ||
      parsed.search ||
      (parsed.protocol === 'https:' && parsed.username)
    ) {
      throw new BundledSeedError('seed.remote_invalid', 'Bundled Harness remote URL is invalid.')
    }
    return
  }
  if (!/^(?:[A-Za-z_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9.-]+:.+$/u.test(value)) {
    throw new BundledSeedError(
      'seed.remote_invalid',
      'Bundled Harness remote URL must use HTTPS or SSH.'
    )
  }
}

function assertCommit(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new BundledSeedError(
      'seed.manifest_invalid',
      `${label} must be a full lowercase Git SHA-1.`
    )
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new BundledSeedError('seed.manifest_invalid', `${label} must be a SHA-256 digest.`)
  }
}

function assertByteLength(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BundledSeedError(
      'seed.manifest_invalid',
      `${label} must be a non-negative byte length.`
    )
  }
}

function assertOpaqueId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new BundledSeedError('seed.manifest_invalid', `${label} is invalid.`)
  }
}

function assertResourcePath(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._@/-]*$/u.test(value) ||
    value.includes('//') ||
    value.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new BundledSeedError('seed.manifest_invalid', `${label} is invalid.`)
  }
}

function assertExpectedBundles(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== EXPECTED_BUNDLES.length ||
    value.some((entry, index) => entry !== EXPECTED_BUNDLES[index])
  ) {
    throw new BundledSeedError('seed.manifest_invalid', `${label} are invalid.`)
  }
}

function assertPluginPackageManifest(value) {
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
    throw new BundledSeedError(
      'seed.resource_invalid',
      'Bundled plugin package manifest is invalid.'
    )
  }
}

function assertPluginGenerationManifest(value, harnessRevision) {
  const manifest = exactObject(
    value,
    ['format', 'version', 'generationId', 'harnessRevision', 'resolution', 'bundles'],
    'Bundled plugin generation manifest'
  )
  if (
    manifest.format !== 'dsh-launcher-plugin-generation' ||
    manifest.version !== 1 ||
    manifest.generationId !== `bundled-${harnessRevision}` ||
    manifest.harnessRevision !== harnessRevision ||
    manifest.resolution !== 'selected-harness-worktree'
  ) {
    throw new BundledSeedError(
      'seed.resource_invalid',
      'Bundled plugin generation manifest is invalid.'
    )
  }
  assertExpectedBundles(manifest.bundles, 'Bundled plugin generation manifest bundles')
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BundledSeedError('seed.manifest_invalid', `${label} must be an object.`)
  }
  const record = value
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new BundledSeedError('seed.manifest_invalid', `${label} has unexpected fields.`)
  }
  return record
}

function resolveResourcePath(root, relativePath) {
  const resolved = path.resolve(root, relativePath)
  const relation = path.relative(root, resolved)
  if (
    relation === '' ||
    relation === '..' ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new BundledSeedError(
      'seed.manifest_invalid',
      'Bundled seed resource path escapes its root.'
    )
  }
  return resolved
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function isNodeCode(value, code) {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === code)
}
