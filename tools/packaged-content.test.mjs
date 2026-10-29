// @vitest-environment node
import asar from '@electron/asar'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeArchiveMember,
  PACKAGED_CONTENT_EVIDENCE,
  scanPackagedContent
} from './packaged-content.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const execute = promisify(execFile)
const fixtures = []
const manifest = {
  schemaVersion: 1,
  version: '1.2.3',
  distributionChannel: 'stable',
  packageName: '@example/launcher',
  productName: 'Test App'
}
const metadata = {
  name: manifest.packageName,
  version: manifest.version,
  dshkerDistributionChannel: 'stable'
}

async function fixture() {
  const parent = path.join(appRoot, '.run', 'packaged-content-tests')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, 'case-'))
  fixtures.push(root)
  const releaseDir = path.join(root, 'release')
  await mkdir(releaseDir)
  await writeFile(path.join(releaseDir, 'release-manifest.json'), JSON.stringify(manifest))
  return { root, releaseDir }
}

async function stage(
  f,
  layout = 'win-unpacked/resources',
  members = {},
  packageMetadata = metadata
) {
  const source = path.join(f.root, `source-${Math.random().toString(16).slice(2)}`)
  await mkdir(source)
  if (packageMetadata !== null)
    await writeFile(
      path.join(source, 'package.json'),
      typeof packageMetadata === 'string' ? packageMetadata : JSON.stringify(packageMetadata)
    )
  for (const [member, contents] of Object.entries({
    'out/main/index.cjs': 'module.exports = 1',
    ...members
  })) {
    const file = path.join(source, ...member.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, contents)
  }
  const destination = path.join(f.releaseDir, ...layout.split('/'), 'app.asar')
  await mkdir(path.dirname(destination), { recursive: true })
  await asar.createPackage(source, destination)
  return destination
}

afterEach(async () => {
  asar.uncacheAll()
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('packaged production archive admission', () => {
  it('reads real ASAR contents from every Windows, macOS and Linux unpacked layout', async () => {
    const f = await fixture()
    for (const layout of [
      'win-unpacked/resources',
      'win-arm64-unpacked/resources',
      'linux-x64-unpacked/resources',
      'linux-arm64-unpacked/resources',
      'mac/Test App.app/Contents/Resources',
      'mac-arm64/Test App.app/Contents/Resources',
      'mac-universal/Test App.app/Contents/Resources'
    ]) {
      await stage(f, layout, {
        'node_modules/runtime-lib/package.json':
          '{"name":"runtime-lib","description":"runtime parser"}'
      })
    }
    const result = await scanPackagedContent(f.releaseDir)
    expect(result.ok).toBe(true)
    expect(result.archives).toHaveLength(7)
    for (const archive of result.archives)
      expect(archive).toMatchObject({
        ok: true,
        packages: 1,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      })
  })

  it('rejects test, fixture, support and mock files at arbitrary dependency depths', async () => {
    const f = await fixture()
    const forbidden = [
      'node_modules/@desktop-workspace/foundation/src/window.test.ts',
      'node_modules/runtime-lib/nested/adapter.spec.js',
      'out/renderer/shell.e2e.js',
      'node_modules/runtime-lib/fixtures/sample.json',
      'node_modules/runtime-lib/fixture-data.js',
      'node_modules/another/node_modules/deep/__mocks__/api.js',
      'node_modules/runtime-lib/test-support/clock.js',
      'node_modules/@scope/mock-library/index.js',
      'node_modules/runtime-lib/MockAgent.js'
    ]
    await stage(f, undefined, Object.fromEntries(forbidden.map((member) => [member, 'test-only'])))
    const result = await scanPackagedContent(f.releaseDir)
    expect(result.ok).toBe(false)
    const rejected = result.issues
      .filter((issue) => issue.code === 'production_content.test_member')
      .map((issue) => issue.member)
    for (const member of forbidden) expect(rejected).toContain(member)
  })

  it('rejects mock libraries from package metadata and test framework packages without mock in their names', async () => {
    const f = await fixture()
    await stage(f, undefined, {
      'node_modules/opaque-helper/package.json':
        '{"name":"opaque-helper","description":"HTTP mocking helpers"}',
      'node_modules/@vitest/spy/package.json': '{"name":"@vitest/spy"}',
      'node_modules/sinon/package.json': '{"name":"sinon"}'
    })
    const result = await scanPackagedContent(f.releaseDir)
    expect(result.ok).toBe(false)
    expect(
      result.issues
        .filter((issue) => issue.code === 'production_content.test_dependency')
        .map((issue) => issue.member)
    ).toEqual(
      expect.arrayContaining([
        'node_modules/opaque-helper/package.json',
        'node_modules/@vitest/spy/package.json',
        'node_modules/sinon/package.json'
      ])
    )
  })

  it.each([
    { ...metadata, version: '0.0.1' },
    { ...metadata, dshkerDistributionChannel: 'test' },
    { ...metadata, dshkerDistributionChannel: undefined },
    { ...metadata, name: 'another-package' }
  ])('refuses package metadata that disagrees with the release manifest: %j', async (value) => {
    const f = await fixture()
    await stage(f, undefined, {}, value)
    const result = await scanPackagedContent(f.releaseDir)
    expect(result.ok).toBe(false)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'production_content.identity_mismatch' })
    )
  })

  it.each([null, '{bad json'])(
    'refuses missing or malformed root package metadata: %j',
    async (value) => {
      const f = await fixture()
      await stage(f, undefined, {}, value)
      const result = await scanPackagedContent(f.releaseDir)
      expect(result.ok).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'production_content.package_metadata_missing_or_invalid' })
      )
    }
  )

  it('fails when any native archive is missing even when another archive is clean', async () => {
    const f = await fixture()
    await stage(f)
    await mkdir(path.join(f.releaseDir, 'linux-arm64-unpacked', 'resources'), { recursive: true })
    const result = await scanPackagedContent(f.releaseDir)
    expect(result.ok).toBe(false)
    expect(result.archives).toHaveLength(2)
    expect(result.issues).toContainEqual({
      code: 'production_content.archive_missing_or_invalid',
      archive: 'linux-arm64-unpacked/resources/app.asar'
    })
  })

  it('refuses malformed archives, missing native builds and missing manifest metadata', async () => {
    const f = await fixture()
    expect((await scanPackagedContent(f.releaseDir)).issues).toContainEqual({
      code: 'production_content.unpacked_missing'
    })
    const archive = path.join(f.releaseDir, 'win-unpacked', 'resources', 'app.asar')
    await mkdir(path.dirname(archive), { recursive: true })
    await writeFile(archive, 'not an archive')
    expect((await scanPackagedContent(f.releaseDir)).issues).toContainEqual(
      expect.objectContaining({ code: 'production_content.archive_unreadable' })
    )
    await rm(path.join(f.releaseDir, 'release-manifest.json'))
    expect((await scanPackagedContent(f.releaseDir)).issues).toContainEqual({
      code: 'production_content.manifest_missing_or_invalid'
    })
  })

  it('normalizes Windows ASAR separators before checking nested members', () => {
    expect(normalizeArchiveMember('\\node_modules\\@scope\\library\\source.test.ts')).toBe(
      'node_modules/@scope/library/source.test.ts'
    )
  })

  it('accepts an explicitly matching test channel and reopens an archive rebuilt at the same path', async () => {
    const f = await fixture()
    await writeFile(
      path.join(f.releaseDir, 'release-manifest.json'),
      JSON.stringify({ ...manifest, distributionChannel: 'test' })
    )
    await stage(f, undefined, {}, { ...metadata, dshkerDistributionChannel: 'test' })
    expect((await scanPackagedContent(f.releaseDir)).ok).toBe(true)
    await stage(
      f,
      undefined,
      { 'node_modules/deep/fixture/only.json': '{}' },
      { ...metadata, dshkerDistributionChannel: 'test' }
    )
    expect((await scanPackagedContent(f.releaseDir)).issues).toContainEqual(
      expect.objectContaining({
        code: 'production_content.test_member',
        member: 'node_modules/deep/fixture/only.json'
      })
    )
  })

  it('makes the release smoke fail productionContent before launching a contaminated package', async () => {
    const f = await fixture()
    const folder =
      process.platform === 'darwin'
        ? 'mac/Test App.app/Contents/Resources'
        : process.platform === 'win32'
          ? 'win-unpacked/resources'
          : 'linux-unpacked/resources'
    await stage(f, folder, { 'node_modules/deep/test.js': 'test-only' })
    const executable =
      process.platform === 'darwin'
        ? 'mac/Test App.app/Contents/MacOS/Test App'
        : process.platform === 'win32'
          ? 'win-unpacked/Test App.exe'
          : 'linux-unpacked/dshker-launcher'
    const executablePath = path.join(f.releaseDir, ...executable.split('/'))
    await mkdir(path.dirname(executablePath), { recursive: true })
    await writeFile(executablePath, 'must never execute')
    await writeFile(
      path.join(f.releaseDir, 'release-manifest.json'),
      JSON.stringify({ ...manifest, artifacts: [] })
    )
    const result = await execute(
      process.execPath,
      [
        path.join(appRoot, 'tools', 'release-smoke.mjs'),
        '--release-dir',
        path.relative(appRoot, f.releaseDir),
        '--launch',
        '--json'
      ],
      { cwd: appRoot, windowsHide: true }
    ).catch((error) => error)
    expect(result.code).toBe(1)
    const output = JSON.parse(result.stdout)
    expect(output.checks.productionContent).toBe(false)
    expect(output.productionContent.issues).toContainEqual(
      expect.objectContaining({ member: 'node_modules/deep/test.js' })
    )
    expect(output.launch).toBeUndefined()
  })

  it('runs the real CLI and writes only its fixed repository-local evidence artifact', async () => {
    const f = await fixture()
    await stage(f)
    const result = await execute(
      process.execPath,
      [
        path.join(appRoot, 'tools', 'packaged-content.mjs'),
        '--release-dir',
        path.relative(appRoot, f.releaseDir),
        '--json'
      ],
      { cwd: appRoot, windowsHide: true }
    )
    expect(JSON.parse(result.stdout).ok).toBe(true)
    expect(
      JSON.parse(await readFile(path.join(appRoot, PACKAGED_CONTENT_EVIDENCE), 'utf8')).ok
    ).toBe(true)
    await stage(f, 'linux-unpacked/resources', {
      'node_modules/mock-anything/index.js': 'mock-only'
    })
    await expect(
      execute(
        process.execPath,
        [
          path.join(appRoot, 'tools', 'packaged-content.mjs'),
          '--release-dir',
          path.relative(appRoot, f.releaseDir),
          '--json'
        ],
        { cwd: appRoot, windowsHide: true }
      )
    ).rejects.toMatchObject({ code: 1 })
  })
})
