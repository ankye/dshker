import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  LauncherUpdateRuntimeError,
  LauncherUpdateService,
  compareLauncherVersions,
  expectedLauncherInstallerAssetName,
  parseLatestRelease,
  scheduleLauncherUpdateCheckAfterWindowReady
} from './launcher-update-service'

function releasePayload(version = '0.2.0', assetNames?: readonly string[]) {
  const tag = `v${version}`
  const names = assetNames ?? [`dshker-launcher-${version}-mac-arm64.dmg`]
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/ankye/dshker/releases/tag/${tag}`,
    assets: names.map((name) => ({
      name,
      browser_download_url: `https://github.com/ankye/dshker/releases/download/${tag}/${name}`
    }))
  }
}

function response(payload: unknown, options?: { ok?: boolean; status?: number }) {
  return {
    ok: options?.ok ?? true,
    status: options?.status ?? 200,
    json: vi.fn(async () => payload)
  }
}

interface TestFetchResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

type TestFetchRelease = (
  url: 'https://api.github.com/repos/ankye/dshker/releases/latest',
  init: Readonly<{ headers: Readonly<Record<string, string>> }>
) => Promise<TestFetchResponse>

type TestDownloadInstaller = (
  url: string,
  destinationPath: string,
  onProgress: (progress: { bytesReceived: number; totalBytes?: number }) => void
) => Promise<void>

function service(options?: {
  payload?: unknown
  fetchRelease?: TestFetchRelease
  downloadInstaller?: TestDownloadInstaller
  platform?: NodeJS.Platform
  arch?: string
  currentVersion?: string
}) {
  const fetchRelease =
    options?.fetchRelease ??
    vi.fn<TestFetchRelease>(async () => response(options?.payload ?? releasePayload()))
  const downloadInstaller =
    options?.downloadInstaller ??
    vi.fn<TestDownloadInstaller>(async (_url, _destinationPath, onProgress) => {
      onProgress({ bytesReceived: 4, totalBytes: 4 })
    })
  return {
    fetchRelease,
    downloadInstaller,
    updateService: new LauncherUpdateService({
      currentVersion: options?.currentVersion ?? '0.1.6',
      platform: options?.platform ?? 'darwin',
      arch: options?.arch ?? 'arm64',
      downloadsDirectory: '/tmp/dshker-launcher-tests',
      fetchRelease,
      downloadInstaller,
      now: () => new Date('2026-09-04T08:00:00.000Z')
    })
  }
}

describe('Launcher update release parsing', () => {
  it('accepts one stable release and preserves only the required fields', () => {
    expect(parseLatestRelease(releasePayload())).toEqual({
      tag: 'v0.2.0',
      version: '0.2.0',
      releasePageUrl: 'https://github.com/ankye/dshker/releases/tag/v0.2.0',
      notes: undefined,
      assets: [
        {
          name: 'dshker-launcher-0.2.0-mac-arm64.dmg',
          downloadUrl:
            'https://github.com/ankye/dshker/releases/download/v0.2.0/dshker-launcher-0.2.0-mac-arm64.dmg'
        }
      ]
    })
  })

  it('carries the release body through so the app can show what changed', () => {
    // Without this the update only reported that a newer version existed and the
    // user had to open GitHub to learn what was in it.
    const parsed = parseLatestRelease({
      ...releasePayload(),
      body: '- Fixed a thing\n- Added another'
    })
    expect(parsed.notes).toBe('- Fixed a thing\n- Added another')
  })

  it.each([
    { label: 'absent', body: undefined },
    { label: 'empty', body: '   \n  ' },
    { label: 'not a string', body: 42 }
  ])('treats a $label body as no notes rather than a failure', ({ body }) => {
    // Notes are descriptive: their absence must never block an update.
    expect(parseLatestRelease({ ...releasePayload(), body }).notes).toBeUndefined()
  })

  it('strips control characters from the untrusted body', () => {
    const parsed = parseLatestRelease({
      ...releasePayload(),
      body: 'Fixed\u0000 a\u001b[31m thing\u007f'
    })
    expect(parsed.notes).toBe('Fixed a[31m thing')
  })

  it('normalizes line endings and collapses long gaps', () => {
    const parsed = parseLatestRelease({
      ...releasePayload(),
      body: 'First\r\nSecond\r\n\r\n\r\n\r\nThird'
    })
    expect(parsed.notes).toBe('First\nSecond\n\nThird')
  })

  it('bounds a very long body so it cannot dominate the screen', () => {
    const parsed = parseLatestRelease({ ...releasePayload(), body: 'x'.repeat(9000) })
    expect(parsed.notes!.length).toBeLessThanOrEqual(4001)
    expect(parsed.notes!.endsWith('…')).toBe(true)
  })

  it.each([
    { ...releasePayload(), draft: true },
    { ...releasePayload(), prerelease: true },
    { ...releasePayload(), tag_name: 'v0.2.0-beta.1' }
  ])('rejects draft, prerelease, and non-stable tags', (payload) => {
    expect(() => parseLatestRelease(payload)).toThrowError(
      expect.objectContaining({ code: 'launcher.update_release_unsupported' })
    )
  })

  it('rejects a release page outside the fixed repository and tag', () => {
    expect(() =>
      parseLatestRelease({
        ...releasePayload(),
        html_url: 'https://github.com/another/repository/releases/tag/v0.2.0'
      })
    ).toThrowError(expect.objectContaining({ code: 'launcher.update_release_url_invalid' }))
  })
})

describe('Launcher update version and package matrix', () => {
  it('compares stable semantic versions numerically', () => {
    expect(compareLauncherVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareLauncherVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareLauncherVersions('0.9.9', '1.0.0')).toBe(-1)
  })

  it('selects the exact macOS and Windows package names', () => {
    expect(expectedLauncherInstallerAssetName('darwin', 'arm64', '1.2.3')).toBe(
      'dshker-launcher-1.2.3-mac-arm64.dmg'
    )
    expect(expectedLauncherInstallerAssetName('darwin', 'x64', '1.2.3')).toBe(
      'dshker-launcher-1.2.3-mac-x64.dmg'
    )
    expect(expectedLauncherInstallerAssetName('win32', 'x64', '1.2.3')).toBe(
      'dshker-launcher-1.2.3-win-x64.exe'
    )
    expect(expectedLauncherInstallerAssetName('win32', 'arm64', '1.2.3')).toBe(
      'dshker-launcher-1.2.3-win-arm64.exe'
    )
  })

  it.each([
    ['darwin', 'x64', 'dshker-launcher-0.2.0-mac-x64.dmg'],
    ['win32', 'arm64', 'dshker-launcher-0.2.0-win-arm64.exe']
  ] as const)('accepts the %s %s update asset', (platform, arch, assetName) => {
    const { updateService } = service({
      platform,
      arch,
      payload: releasePayload('0.2.0', [assetName])
    })
    return expect(updateService.check()).resolves.toMatchObject({
      kind: 'update-available',
      assetName
    })
  })

  it('rejects every platform and architecture outside the package matrix', () => {
    expect(() => expectedLauncherInstallerAssetName('linux', 'x64', '1.2.3')).toThrowError(
      expect.objectContaining({ code: 'launcher.update_platform_unsupported' })
    )
  })
})

describe('LauncherUpdateService', () => {
  it('publishes an available update and downloads only its cached exact installer URL', async () => {
    const { updateService, fetchRelease, downloadInstaller } = service()

    await expect(updateService.check()).resolves.toEqual({
      kind: 'update-available',
      currentVersion: '0.1.6',
      latestVersion: '0.2.0',
      assetName: 'dshker-launcher-0.2.0-mac-arm64.dmg',
      releasePageUrl: 'https://github.com/ankye/dshker/releases/tag/v0.2.0',
      download: { kind: 'idle' },
      checkedAt: '2026-09-04T08:00:00.000Z'
    })
    await expect(updateService.downloadInstaller()).resolves.toMatchObject({
      kind: 'update-available',
      download: { kind: 'downloaded' }
    })

    expect(downloadInstaller).toHaveBeenCalledWith(
      'https://github.com/ankye/dshker/releases/download/v0.2.0/dshker-launcher-0.2.0-mac-arm64.dmg',
      path.join('/tmp/dshker-launcher-tests', 'dshker-launcher-0.2.0-mac-arm64.dmg'),
      expect.any(Function)
    )
    expect(fetchRelease).toHaveBeenCalledWith(
      'https://api.github.com/repos/ankye/dshker/releases/latest',
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'DSHKer-Launcher/0.1.6',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    )
  })

  it('reports an equal or older remote release as up to date', async () => {
    const equal = service({ payload: releasePayload('0.1.6') }).updateService
    const older = service({
      payload: releasePayload('0.1.5'),
      currentVersion: '0.1.6'
    }).updateService

    await expect(equal.check()).resolves.toMatchObject({
      kind: 'up-to-date',
      latestVersion: '0.1.6'
    })
    await expect(older.check()).resolves.toMatchObject({
      kind: 'up-to-date',
      latestVersion: '0.1.5'
    })
  })

  it.each([
    {
      names: [],
      code: 'launcher.update_asset_missing'
    },
    {
      names: ['dshker-launcher-0.2.0-mac-arm64.dmg', 'dshker-launcher-0.2.0-mac-arm64.dmg'],
      code: 'launcher.update_asset_ambiguous'
    }
  ])('reports a missing or repeated exact package as failed', async ({ names, code }) => {
    const { updateService } = service({ payload: releasePayload('0.2.0', names) })

    await expect(updateService.check()).resolves.toMatchObject({ kind: 'failed', code })
  })

  it('rejects an exact asset name whose URL is not the exact GitHub release asset', async () => {
    const payload = releasePayload()
    payload.assets[0].browser_download_url = 'https://example.com/installer.dmg'
    const { updateService } = service({ payload })

    await expect(updateService.check()).resolves.toMatchObject({
      kind: 'failed',
      code: 'launcher.update_asset_url_invalid'
    })
  })

  it('fails an unsupported target before issuing any network request', async () => {
    const { updateService, fetchRelease } = service({ platform: 'linux', arch: 'x64' })

    await expect(updateService.check()).resolves.toMatchObject({
      kind: 'failed',
      code: 'launcher.update_platform_unsupported'
    })
    expect(fetchRelease).not.toHaveBeenCalled()
  })

  it.each([
    {
      fetchRelease: vi.fn(async () => {
        throw new Error('offline')
      }),
      code: 'launcher.update_network_failed'
    },
    {
      fetchRelease: vi.fn(async () => response({}, { ok: false, status: 503 })),
      code: 'launcher.update_http_failed'
    },
    {
      fetchRelease: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('bad json')
        }
      })),
      code: 'launcher.update_response_invalid'
    }
  ])(
    'turns network, HTTP, and JSON failures into stable failed states',
    async ({ fetchRelease, code }) => {
      const { updateService } = service({ fetchRelease })

      await expect(updateService.check()).resolves.toMatchObject({ kind: 'failed', code })
    }
  )

  it('does not download before an available release has been verified', async () => {
    const { updateService, downloadInstaller } = service()

    await expect(updateService.downloadInstaller()).rejects.toEqual(
      expect.objectContaining({ code: 'launcher.update_not_available' })
    )
    expect(downloadInstaller).not.toHaveBeenCalled()
  })

  it('reports a download failure without exposing its cause', async () => {
    const downloadInstaller = vi.fn<TestDownloadInstaller>(async () => {
      throw new Error('private filesystem detail')
    })
    const { updateService } = service({ downloadInstaller })
    await updateService.check()

    await expect(updateService.downloadInstaller()).rejects.toEqual(
      expect.objectContaining({ code: 'launcher.update_download_failed' })
    )
  })

  it('coalesces repeated download requests while the installer is transferring', async () => {
    let releaseDownload!: () => void
    const downloadInstaller = vi.fn<TestDownloadInstaller>(
      async () =>
        await new Promise<void>((resolve) => {
          releaseDownload = resolve
        })
    )
    const { updateService } = service({ downloadInstaller })
    await updateService.check()

    const first = updateService.downloadInstaller()
    const second = updateService.downloadInstaller()
    expect(downloadInstaller).toHaveBeenCalledOnce()
    releaseDownload()
    await expect(first).resolves.toMatchObject({ download: { kind: 'downloaded' } })
    await expect(second).resolves.toMatchObject({ download: { kind: 'downloaded' } })
  })

  it('does not let an old download complete a newer update generation', async () => {
    let releaseDownload!: () => void
    const fetchRelease = vi
      .fn<TestFetchRelease>()
      .mockResolvedValueOnce(response(releasePayload('0.2.0')))
      .mockResolvedValueOnce(response(releasePayload('0.2.1')))
    const downloadInstaller = vi.fn<TestDownloadInstaller>(
      async () =>
        await new Promise<void>((resolve) => {
          releaseDownload = resolve
        })
    )
    const { updateService } = service({ fetchRelease, downloadInstaller })
    await updateService.check()
    const oldDownload = updateService.downloadInstaller()
    await updateService.check()

    releaseDownload()
    await expect(oldDownload).rejects.toEqual(
      expect.objectContaining({ code: 'launcher.update_not_available' })
    )
    expect(updateService.getState()).toMatchObject({
      kind: 'update-available',
      latestVersion: '0.2.1',
      download: { kind: 'idle' }
    })
  })

  it('withdraws a retained installer as soon as a later check supersedes it', async () => {
    const fetchRelease = vi
      .fn<TestFetchRelease>()
      .mockResolvedValueOnce(response(releasePayload()))
      .mockRejectedValueOnce(new Error('offline'))
    const { updateService, downloadInstaller } = service({ fetchRelease })
    await updateService.check()
    await updateService.check()

    await expect(updateService.downloadInstaller()).rejects.toEqual(
      expect.objectContaining({ code: 'launcher.update_not_available' })
    )
    expect(downloadInstaller).not.toHaveBeenCalled()
  })

  it('schedules startup discovery only after the window is ready and never awaits it', () => {
    let ready: (() => void) | undefined
    const window = {
      once: vi.fn((_event: 'ready-to-show', listener: () => void) => {
        ready = listener
      })
    }
    const check = vi.fn(() => new Promise<never>(() => undefined))

    scheduleLauncherUpdateCheckAfterWindowReady(window, { check })
    expect(check).not.toHaveBeenCalled()
    expect(ready?.()).toBeUndefined()
    expect(check).toHaveBeenCalledOnce()
  })

  it('preserves its runtime error identity', () => {
    expect(
      new LauncherUpdateRuntimeError('launcher.update_network_failed', 'network')
    ).toBeInstanceOf(Error)
  })
})
