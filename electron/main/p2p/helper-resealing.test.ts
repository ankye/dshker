import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import afterSign from '../../../tools/after-sign-peer-helper.mjs'

/**
 * The helper manifest is written when the Go binary is built, but electron-builder
 * then code-signs every executable in the package, which rewrites the binary. The
 * recorded digest therefore described a file that no longer shipped, and since the
 * launcher verifies that digest before starting the helper, it refused: the app
 * opened normally, the helper never ran, and P2P was silently dead in every
 * packaged build with nothing failing at build time.
 */
describe('peer helper manifest resealing', () => {
  async function packaged(options: {
    readonly binary: string
    readonly recordedDigest: string
    readonly target?: string
  }) {
    const root = await mkdtemp(join(tmpdir(), 'after-sign-'))
    const resources = join(root, 'Fixture.app', 'Contents', 'Resources')
    const target = options.target ?? 'darwin-arm64'
    const directory = join(resources, 'p2p', target)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'dshker-peer'), options.binary)
    await writeFile(
      join(directory, 'manifest.json'),
      `${JSON.stringify({ version: 1, target, file: 'dshker-peer', sha256: options.recordedDigest })}\n`
    )
    return {
      context: {
        appOutDir: root,
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'Fixture' } }
      },
      directory,
      manifestPath: join(directory, 'manifest.json')
    }
  }

  const digestOf = (value: string) => createHash('sha256').update(value).digest('hex')

  it('corrects a digest invalidated by signing', async () => {
    const { context, manifestPath } = await packaged({
      binary: 'signed-bytes',
      recordedDigest: digestOf('unsigned-bytes')
    })
    await afterSign(context)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(manifest.sha256).toBe(digestOf('signed-bytes'))
  })

  it('preserves every other field the runtime verifies', async () => {
    // The runtime checks version, target and file as well as the digest.
    const { context, manifestPath } = await packaged({
      binary: 'signed-bytes',
      recordedDigest: digestOf('unsigned-bytes')
    })
    await afterSign(context)
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual({
      version: 1,
      target: 'darwin-arm64',
      file: 'dshker-peer',
      sha256: digestOf('signed-bytes')
    })
  })

  it('leaves an already correct manifest untouched', async () => {
    const { context, manifestPath } = await packaged({
      binary: 'signed-bytes',
      recordedDigest: digestOf('signed-bytes')
    })
    const before = await readFile(manifestPath, 'utf8')
    await afterSign(context)
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
  })

  it('refuses a manifest whose target is not its directory', async () => {
    // A mismatched pair means the wrong helper was packaged, which resealing
    // would otherwise make look valid.
    const { context, directory } = await packaged({
      binary: 'signed-bytes',
      recordedDigest: digestOf('signed-bytes')
    })
    await writeFile(
      join(directory, 'manifest.json'),
      `${JSON.stringify({ version: 1, target: 'win32-x64', file: 'dshker-peer', sha256: 'x' })}\n`
    )
    await expect(afterSign(context)).rejects.toThrow(/target/u)
  })

  it('does nothing when the package has no helper directory', async () => {
    // Nothing to reseal is not a failure; the packaging test guards presence.
    const root = await mkdtemp(join(tmpdir(), 'after-sign-empty-'))
    await mkdir(join(root, 'Fixture.app', 'Contents', 'Resources'), { recursive: true })
    await expect(
      afterSign({
        appOutDir: root,
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'Fixture' } }
      })
    ).resolves.toBeUndefined()
  })
})
