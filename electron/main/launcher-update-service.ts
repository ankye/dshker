import type { LauncherUpdateErrorCode, LauncherUpdateState } from '../../src/shared/contracts'

/** Fixed public endpoint for the only Launcher release source. */
export const LAUNCHER_RELEASE_API_URL =
  'https://api.github.com/repos/ankye/dshker/releases/latest' as const

const GITHUB_ORIGIN = 'https://github.com'
const RELEASE_PATH_PREFIX = '/ankye/dshker/releases'

interface LauncherUpdateFetchResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

interface LauncherUpdateServiceOptions {
  readonly currentVersion: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly fetchRelease?: (
    url: typeof LAUNCHER_RELEASE_API_URL,
    init: Readonly<{ headers: Readonly<Record<string, string>> }>
  ) => Promise<LauncherUpdateFetchResponse>
  readonly openExternal: (url: string) => Promise<void>
  readonly now?: () => Date
}

interface ParsedRelease {
  readonly tag: string
  readonly version: string
  readonly releasePageUrl: string
  readonly assets: readonly ParsedReleaseAsset[]
}

interface ParsedReleaseAsset {
  readonly name: string
  readonly downloadUrl: string
}

type StateListener = (state: LauncherUpdateState) => void

/** One sanitized update failure owned by the main process. */
export class LauncherUpdateRuntimeError extends Error {
  constructor(
    readonly code: LauncherUpdateErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'LauncherUpdateRuntimeError'
  }
}

/**
 * Discovers and opens one exact release installer without exposing its URL to the renderer.
 */
export class LauncherUpdateService {
  private state: LauncherUpdateState
  private readonly listeners = new Set<StateListener>()
  private pendingCheck: Promise<LauncherUpdateState> | undefined
  private cachedInstallerUrl: string | undefined

  constructor(private readonly options: LauncherUpdateServiceOptions) {
    parseVersion(options.currentVersion)
    this.state = { kind: 'idle', currentVersion: options.currentVersion }
  }

  /** Returns the last completed or in-progress discovery state. */
  getState(): LauncherUpdateState {
    return this.state
  }

  /** Subscribes to state changes and returns an exact disposer. */
  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Runs one shared strict latest-release request. */
  check(): Promise<LauncherUpdateState> {
    if (this.pendingCheck !== undefined) return this.pendingCheck
    this.cachedInstallerUrl = undefined
    this.transition({ kind: 'checking', currentVersion: this.options.currentVersion })
    const pending = this.performCheck().finally(() => {
      if (this.pendingCheck === pending) this.pendingCheck = undefined
    })
    this.pendingCheck = pending
    return pending
  }

  /** Opens the cached installer only while its matching update remains available. */
  async openInstallerDownload(): Promise<LauncherUpdateState> {
    if (this.state.kind !== 'update-available' || this.cachedInstallerUrl === undefined) {
      throw new LauncherUpdateRuntimeError(
        'launcher.update_not_available',
        'No verified Launcher installer is available.'
      )
    }
    validateInstallerUrl(
      this.cachedInstallerUrl,
      `v${this.state.latestVersion}`,
      this.state.assetName
    )
    try {
      await this.options.openExternal(this.cachedInstallerUrl)
    } catch {
      throw new LauncherUpdateRuntimeError(
        'launcher.update_open_failed',
        'The verified Launcher installer could not be opened.'
      )
    }
    return this.state
  }

  private async performCheck(): Promise<LauncherUpdateState> {
    const checkedAt = (this.options.now ?? (() => new Date()))().toISOString()
    try {
      const targetSuffix = launcherInstallerTargetSuffix(this.options.platform, this.options.arch)
      const release = await this.fetchLatestRelease()
      const assetName = createInstallerAssetName(release.version, targetSuffix)
      const asset = selectInstallerAsset(release, assetName)
      const compared = compareLauncherVersions(this.options.currentVersion, release.version)
      if (compared >= 0) {
        return this.transition({
          kind: 'up-to-date',
          currentVersion: this.options.currentVersion,
          latestVersion: release.version,
          checkedAt
        })
      }
      this.cachedInstallerUrl = asset.downloadUrl
      return this.transition({
        kind: 'update-available',
        currentVersion: this.options.currentVersion,
        latestVersion: release.version,
        assetName: asset.name,
        releasePageUrl: release.releasePageUrl,
        checkedAt
      })
    } catch (error) {
      this.cachedInstallerUrl = undefined
      const failure =
        error instanceof LauncherUpdateRuntimeError
          ? error
          : new LauncherUpdateRuntimeError(
              'launcher.update_response_invalid',
              'The latest Launcher release response is invalid.'
            )
      return this.transition({
        kind: 'failed',
        currentVersion: this.options.currentVersion,
        code: failure.code,
        checkedAt
      })
    }
  }

  private async fetchLatestRelease(): Promise<ParsedRelease> {
    const fetchRelease = this.options.fetchRelease ?? defaultFetchRelease
    let response: LauncherUpdateFetchResponse
    try {
      response = await fetchRelease(LAUNCHER_RELEASE_API_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': `DSHKer-Launcher/${this.options.currentVersion}`
        }
      })
    } catch {
      throw new LauncherUpdateRuntimeError(
        'launcher.update_network_failed',
        'The latest Launcher release could not be requested.'
      )
    }
    if (!response.ok) {
      throw new LauncherUpdateRuntimeError(
        'launcher.update_http_failed',
        `The latest Launcher release request returned HTTP ${response.status}.`
      )
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new LauncherUpdateRuntimeError(
        'launcher.update_response_invalid',
        'The latest Launcher release response is not valid JSON.'
      )
    }
    return parseLatestRelease(payload)
  }

  private transition<T extends LauncherUpdateState>(state: T): T {
    this.state = state
    for (const listener of this.listeners) listener(state)
    return state
  }
}

async function defaultFetchRelease(
  url: typeof LAUNCHER_RELEASE_API_URL,
  init: Readonly<{ headers: Readonly<Record<string, string>> }>
): Promise<LauncherUpdateFetchResponse> {
  return fetch(url, init)
}

/** Strictly compares two stable `X.Y.Z` versions. */
export function compareLauncherVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index]
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

/** Returns the sole package filename admitted for one supported target. */
export function expectedLauncherInstallerAssetName(
  platform: NodeJS.Platform,
  arch: string,
  version: string
): string {
  return createInstallerAssetName(version, launcherInstallerTargetSuffix(platform, arch))
}

function launcherInstallerTargetSuffix(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64.dmg'
  if (platform === 'win32' && arch === 'x64') return 'win-x64.exe'
  throw new LauncherUpdateRuntimeError(
    'launcher.update_platform_unsupported',
    `Launcher updates do not support ${platform}-${arch}.`
  )
}

function createInstallerAssetName(version: string, suffix: string): string {
  parseVersion(version)
  return `dshker-launcher-${version}-${suffix}`
}

/** Parses the public GitHub response and rejects unstable or foreign releases. */
export function parseLatestRelease(payload: unknown): ParsedRelease {
  if (!isRecord(payload) || !Array.isArray(payload.assets)) {
    throw invalidResponse()
  }
  if (
    typeof payload.tag_name !== 'string' ||
    typeof payload.draft !== 'boolean' ||
    typeof payload.prerelease !== 'boolean' ||
    typeof payload.html_url !== 'string'
  ) {
    throw invalidResponse()
  }
  if (
    payload.draft ||
    payload.prerelease ||
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(payload.tag_name)
  ) {
    throw new LauncherUpdateRuntimeError(
      'launcher.update_release_unsupported',
      'The latest GitHub release is not a stable Launcher release.'
    )
  }
  const version = payload.tag_name.slice(1)
  parseVersion(version)
  validateReleasePageUrl(payload.html_url, payload.tag_name)
  const assets = payload.assets.map((asset) => {
    if (
      !isRecord(asset) ||
      typeof asset.name !== 'string' ||
      typeof asset.browser_download_url !== 'string'
    ) {
      throw invalidResponse()
    }
    return { name: asset.name, downloadUrl: asset.browser_download_url }
  })
  return {
    tag: payload.tag_name,
    version,
    releasePageUrl: payload.html_url,
    assets
  }
}

function selectInstallerAsset(release: ParsedRelease, expectedName: string): ParsedReleaseAsset {
  const matches = release.assets.filter((asset) => asset.name === expectedName)
  if (matches.length === 0) {
    throw new LauncherUpdateRuntimeError(
      'launcher.update_asset_missing',
      `The release does not contain ${expectedName}.`
    )
  }
  if (matches.length !== 1) {
    throw new LauncherUpdateRuntimeError(
      'launcher.update_asset_ambiguous',
      `The release contains more than one ${expectedName}.`
    )
  }
  const selected = matches[0]
  validateInstallerUrl(selected.downloadUrl, release.tag, expectedName)
  return selected
}

function validateReleasePageUrl(rawUrl: string, tag: string): void {
  const url = parseHttpsGithubUrl(rawUrl, 'launcher.update_release_url_invalid')
  if (url.pathname !== `${RELEASE_PATH_PREFIX}/tag/${tag}`) {
    throw new LauncherUpdateRuntimeError(
      'launcher.update_release_url_invalid',
      'The release page URL does not identify the selected Launcher release.'
    )
  }
}

function validateInstallerUrl(rawUrl: string, tag: string, assetName: string): void {
  const url = parseHttpsGithubUrl(rawUrl, 'launcher.update_asset_url_invalid')
  if (url.pathname !== `${RELEASE_PATH_PREFIX}/download/${tag}/${assetName}`) {
    throw new LauncherUpdateRuntimeError(
      'launcher.update_asset_url_invalid',
      'The installer URL does not identify the selected Launcher asset.'
    )
  }
}

function parseHttpsGithubUrl(rawUrl: string, code: LauncherUpdateErrorCode): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new LauncherUpdateRuntimeError(code, 'The GitHub release URL is invalid.')
  }
  if (
    url.origin !== GITHUB_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new LauncherUpdateRuntimeError(code, 'The GitHub release URL is invalid.')
  }
  return url
}

function parseVersion(version: string): readonly [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version)
  if (match === null) {
    throw new LauncherUpdateRuntimeError(
      'launcher.update_response_invalid',
      `Launcher version ${version} is invalid.`
    )
  }
  const values = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  if (values.some((value) => !Number.isSafeInteger(value))) {
    throw new LauncherUpdateRuntimeError(
      'launcher.update_response_invalid',
      `Launcher version ${version} exceeds the supported numeric range.`
    )
  }
  return values
}

function invalidResponse(): LauncherUpdateRuntimeError {
  return new LauncherUpdateRuntimeError(
    'launcher.update_response_invalid',
    'The latest Launcher release response is invalid.'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Starts discovery after the native window is paint-ready without awaiting the network request. */
export function scheduleLauncherUpdateCheckAfterWindowReady(
  window: { once(event: 'ready-to-show', listener: () => void): unknown },
  service: Pick<LauncherUpdateService, 'check'>
): void {
  window.once('ready-to-show', () => {
    void service.check()
  })
}
