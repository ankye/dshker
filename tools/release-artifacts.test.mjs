import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyReleaseEntry, generate, verify } from './release-artifacts.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runRoot = path.join(appRoot, '.run')
const temporaryDirectories = []
const packageJson = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
const currentVersion = packageJson.version
const staleVersion = currentVersion === '0.0.1' ? '0.0.2' : '0.0.1'

async function createReleaseDirectory() {
  await mkdir(runRoot, { recursive: true })
  const directory = await mkdtemp(path.join(runRoot, 'release-artifacts-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function relativeToApp(filePath) {
  return path.relative(appRoot, filePath)
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('release artifact identity', () => {
  it.each(['stable', 'test'])(
    'round-trips the %s distribution identity independently of the current build environment',
    async (channel) => {
      const releaseDirectory = await createReleaseDirectory()
      await writeFile(
        path.join(releaseDirectory, `dshker-launcher-${currentVersion}-win-x64.exe`),
        'candidate'
      )
      vi.stubEnv('DSHKER_DISTRIBUTION_CHANNEL', channel)
      const { manifest } = await generate({
        releaseDir: relativeToApp(releaseDirectory),
        mode: 'test'
      })
      expect(manifest.distributionChannel).toBe(channel)
      expect(manifest.appId).toBe(packageJson.build.appId + (channel === 'test' ? '.test' : ''))
      expect(manifest.productName).toBe(
        packageJson.build.productName + (channel === 'test' ? ' Test' : '')
      )
      vi.stubEnv('DSHKER_DISTRIBUTION_CHANNEL', channel === 'stable' ? 'test' : 'stable')
      expect(await verify({ releaseDir: relativeToApp(releaseDirectory) })).toMatchObject({
        ok: true
      })
    }
  )

  it('rejects missing or invalid distribution markers and identities inconsistent with their channel', async () => {
    const releaseDirectory = await createReleaseDirectory()
    await writeFile(
      path.join(releaseDirectory, `dshker-launcher-${currentVersion}-win-x64.exe`),
      'candidate'
    )
    vi.stubEnv('DSHKER_DISTRIBUTION_CHANNEL', 'test')
    const { manifest } = await generate({
      releaseDir: relativeToApp(releaseDirectory),
      mode: 'test'
    })
    const filePath = path.join(releaseDirectory, 'release-manifest.json')
    for (const distributionChannel of [undefined, 'production']) {
      await writeFile(filePath, JSON.stringify({ ...manifest, distributionChannel }))
      expect((await verify({ releaseDir: relativeToApp(releaseDirectory) })).issues).toContain(
        'Manifest distribution channel is invalid'
      )
    }
    await writeFile(filePath, JSON.stringify({ ...manifest, distributionChannel: 'stable' }))
    const result = await verify({ releaseDir: relativeToApp(releaseDirectory) })
    expect(result.ok).toBe(false)
    expect(result.issues).toContain('Manifest appId does not match package identity')
    expect(result.issues).toContain('Manifest productName does not match package identity')
  })
  it('classifies explicit older versions without accepting missing or mixed identities', () => {
    expect(
      classifyReleaseEntry(`DSHKer Launcher-${currentVersion}-arm64.dmg`, 'file', currentVersion)
    ).toBe('current')
    expect(
      classifyReleaseEntry(`DSH Launcher-${staleVersion}-arm64.dmg`, 'file', currentVersion)
    ).toBe('stale')
    expect(() => classifyReleaseEntry('DSHKer Launcher-arm64.dmg', 'file', currentVersion)).toThrow(
      `does not identify package version ${currentVersion}`
    )
    expect(() =>
      classifyReleaseEntry(
        `DSHKer-${staleVersion}-to-${currentVersion}-arm64.dmg`,
        'file',
        currentVersion
      )
    ).toThrow('mixes package versions')
  })

  it('records current artifacts while leaving older-version files untouched', async () => {
    const releaseDirectory = await createReleaseDirectory()
    const currentArtifact = `DSHKer Launcher-${currentVersion}-arm64.dmg`
    const staleArtifact = `DSH Launcher-${staleVersion}-arm64.dmg`
    await writeFile(path.join(releaseDirectory, currentArtifact), 'current', 'utf8')
    await writeFile(path.join(releaseDirectory, staleArtifact), 'stale', 'utf8')
    await mkdir(path.join(releaseDirectory, 'mac-arm64'))
    await writeFile(path.join(releaseDirectory, 'mac-arm64', 'app-binary'), 'binary', 'utf8')

    const result = await generate({ releaseDir: relativeToApp(releaseDirectory), mode: 'test' })

    expect(result.manifest.version).toBe(currentVersion)
    expect(result.manifest.artifacts.map((artifact) => artifact.relativePath)).toEqual([
      currentArtifact,
      'mac-arm64'
    ])
    expect(result.staleArtifacts).toEqual([staleArtifact])
    await expect(access(path.join(releaseDirectory, staleArtifact))).resolves.toBeUndefined()
    await expect(verify({ releaseDir: relativeToApp(releaseDirectory) })).resolves.toMatchObject({
      ok: true,
      staleArtifacts: [staleArtifact]
    })
  })

  it('ignores electron-builder updater indexes when creating release metadata', async () => {
    const releaseDirectory = await createReleaseDirectory()
    const currentArtifact = `dshker-launcher-${currentVersion}-mac-arm64.dmg`
    await writeFile(path.join(releaseDirectory, currentArtifact), 'installer', 'utf8')
    await writeFile(path.join(releaseDirectory, 'latest-mac.yml'), 'version: 0.1.7\n', 'utf8')
    await writeFile(
      path.join(releaseDirectory, 'release-smoke-launch.trace'),
      'launch-start\n',
      'utf8'
    )

    const result = await generate({ releaseDir: relativeToApp(releaseDirectory), mode: 'test' })

    expect(result.manifest.artifacts.map((artifact) => artifact.relativePath)).toEqual([
      currentArtifact
    ])
  })

  it('rejects a visible artifact whose filename does not identify this package version', async () => {
    const releaseDirectory = await createReleaseDirectory()
    await mkdir(path.join(releaseDirectory, 'mac-arm64'))
    await writeFile(path.join(releaseDirectory, 'DSHKer Launcher-arm64.dmg'), 'invalid', 'utf8')

    await expect(
      generate({ releaseDir: relativeToApp(releaseDirectory), mode: 'test' })
    ).rejects.toThrow(`does not identify package version ${currentVersion}`)
  })

  it('fails verification when manifest identity drifts from package identity', async () => {
    const releaseDirectory = await createReleaseDirectory()
    await mkdir(path.join(releaseDirectory, 'mac-arm64'))
    await writeFile(path.join(releaseDirectory, 'mac-arm64', 'app-binary'), 'binary', 'utf8')
    await generate({ releaseDir: relativeToApp(releaseDirectory), mode: 'test' })

    const manifestPath = path.join(releaseDirectory, 'release-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.version = staleVersion
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const result = await verify({ releaseDir: relativeToApp(releaseDirectory) })
    expect(result.ok).toBe(false)
    expect(result.issues).toContain(
      `Manifest version ${staleVersion} does not match package version ${currentVersion}`
    )
  })
})
