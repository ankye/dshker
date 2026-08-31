import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadVerifiedBundledSeed } from './bundled-seed'

const REVISION = '0123456789abcdef0123456789abcdef01234567'
const rootsToRemove: string[] = []
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

afterEach(async () => {
  await Promise.all(
    rootsToRemove.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
  if (originalResourcesPath === undefined) {
    Reflect.deleteProperty(process, 'resourcesPath')
  } else {
    Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
  }
})

describe('packaged bundled DSH seed', () => {
  it('accepts only a fully verified seed under process.resourcesPath', async () => {
    const fixture = await createSeedFixture()
    setResourcesPath(fixture.resourcesPath)

    const seed = await loadVerifiedBundledSeed()

    expect(seed.rootPath).toBe(fixture.seedDirectory)
    expect(seed.remoteUrl).toBe('git@github.com:deepseek-ai/DeepSeek-Harness.git')
    expect(seed.revision).toBe(REVISION)
    expect(seed.bundlePath).toBe(fixture.bundlePath)
    expect(seed.bundle).toMatchObject({
      path: 'harness/deepseek-harness.git.bundle',
      bytes: fixture.bundleContents.byteLength,
      sha256: sha256(fixture.bundleContents)
    })
    expect(seed.plugins.packageManifest.contents).toBe(fixture.packageContents)
    expect(seed.plugins.generationManifest).toMatchObject({
      generationId: `bundled-${REVISION}`,
      harnessRevision: REVISION,
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    })
    expect(Object.isFrozen(seed)).toBe(true)
    expect(Object.isFrozen(seed.plugins.generationManifest)).toBe(true)
  })

  it('reports a missing packaged resource as unavailable', async () => {
    const fixture = await createSeedFixture()
    await unlink(fixture.bundlePath)
    setResourcesPath(fixture.resourcesPath)

    await expect(loadVerifiedBundledSeed()).rejects.toMatchObject({
      code: 'bundled_seed.unavailable'
    })
  })

  it('rejects a bundle whose hash changes without changing its size', async () => {
    const fixture = await createSeedFixture()
    await writeFile(fixture.bundlePath, Buffer.alloc(fixture.bundleContents.byteLength, 0x74))
    setResourcesPath(fixture.resourcesPath)

    await expect(loadVerifiedBundledSeed()).rejects.toMatchObject({
      code: 'bundled_seed.integrity_failed'
    })
  })

  it('rejects a bundle whose byte length no longer matches the manifest', async () => {
    const fixture = await createSeedFixture()
    await writeFile(fixture.bundlePath, Buffer.concat([fixture.bundleContents, Buffer.from('x')]))
    setResourcesPath(fixture.resourcesPath)

    await expect(loadVerifiedBundledSeed()).rejects.toMatchObject({
      code: 'bundled_seed.integrity_failed'
    })
  })

  it('rejects a plugin metadata file whose hash no longer matches the manifest', async () => {
    const fixture = await createSeedFixture()
    await writeFile(
      nodePath.join(fixture.seedDirectory, 'plugins', 'generation.json'),
      '{"tampered":true}\n',
      'utf8'
    )
    setResourcesPath(fixture.resourcesPath)

    await expect(loadVerifiedBundledSeed()).rejects.toMatchObject({
      code: 'bundled_seed.integrity_failed'
    })
  })

  it('does not search source or development directories when Electron has no resources path', async () => {
    Reflect.deleteProperty(process, 'resourcesPath')

    await expect(loadVerifiedBundledSeed()).rejects.toMatchObject({
      code: 'bundled_seed.unavailable'
    })
  })
})

async function createSeedFixture(): Promise<{
  readonly resourcesPath: string
  readonly seedDirectory: string
  readonly bundlePath: string
  readonly bundleContents: Buffer
  readonly packageContents: string
}> {
  const resourcesPath = await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-seed-runtime-'))
  rootsToRemove.push(resourcesPath)
  const seedDirectory = nodePath.join(resourcesPath, 'bundled-seed')
  const harnessDirectory = nodePath.join(seedDirectory, 'harness')
  const pluginsDirectory = nodePath.join(seedDirectory, 'plugins')
  await Promise.all([
    mkdir(harnessDirectory, { recursive: true }),
    mkdir(pluginsDirectory, { recursive: true })
  ])

  const bundleContents = Buffer.from('portable DSH Git bundle fixture\n', 'utf8')
  const bundlePath = nodePath.join(harnessDirectory, 'deepseek-harness.git.bundle')
  const packageManifest = {
    name: 'dsh-web-plugin-generation',
    private: true,
    type: 'module'
  }
  const generationManifest = {
    format: 'dsh-launcher-plugin-generation',
    version: 1,
    generationId: `bundled-${REVISION}`,
    harnessRevision: REVISION,
    resolution: 'selected-harness-worktree',
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  }
  const packageContents = `${JSON.stringify(packageManifest, null, 2)}\n`
  const generationContents = `${JSON.stringify(generationManifest, null, 2)}\n`
  const packagePath = nodePath.join(pluginsDirectory, 'package.json')
  const generationPath = nodePath.join(pluginsDirectory, 'generation.json')
  await Promise.all([
    writeFile(bundlePath, bundleContents),
    writeFile(packagePath, packageContents, 'utf8'),
    writeFile(generationPath, generationContents, 'utf8')
  ])

  const resources = [
    resource('harness/deepseek-harness.git.bundle', bundleContents),
    resource('plugins/package.json', Buffer.from(packageContents, 'utf8')),
    resource('plugins/generation.json', Buffer.from(generationContents, 'utf8'))
  ]
  const manifest = {
    format: 'dsh-launcher-bundled-seed',
    version: 1,
    remoteUrl: 'git@github.com:deepseek-ai/DeepSeek-Harness.git',
    harness: {
      revision: REVISION,
      objectFormat: 'sha1',
      bundlePath: 'harness/deepseek-harness.git.bundle',
      bundleSha256: resources[0].sha256,
      bundleBytes: resources[0].bytes
    },
    pluginGeneration: {
      generationId: generationManifest.generationId,
      identity: generationIdentity(generationManifest, resources[1].sha256),
      resourcePath: 'plugins',
      packageManifestPath: 'plugins/package.json',
      packageManifestSha256: resources[1].sha256,
      generationManifestPath: 'plugins/generation.json',
      generationManifestSha256: resources[2].sha256,
      bundles: generationManifest.bundles
    },
    resources
  }
  await writeFile(
    nodePath.join(seedDirectory, 'seed-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
  return { resourcesPath, seedDirectory, bundlePath, bundleContents, packageContents }
}

function resource(path: string, contents: Buffer): { path: string; sha256: string; bytes: number } {
  return { path, sha256: sha256(contents), bytes: contents.byteLength }
}

function generationIdentity(
  generation: {
    readonly format: string
    readonly version: number
    readonly generationId: string
    readonly harnessRevision: string
    readonly resolution: string
    readonly bundles: readonly string[]
  },
  packageManifestSha256: string
): string {
  return sha256(
    Buffer.from(
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
  )
}

function setResourcesPath(resourcesPath: string): void {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath
  })
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}
