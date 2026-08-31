export type PlatformName = 'darwin' | 'win32' | 'linux' | string

export interface AppInfo {
  appId: string
  name: string
  version: string
  platform: PlatformName
  userDataPath: string
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  locale: string
  accentColor: string
  telemetryEnabled: boolean
  autoUpdateChecks: boolean
}

export interface DiagnosticEvent {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  context?: Record<string, unknown>
}

export interface StorageEntry {
  namespace: string
  key: string
  value: unknown
}

export interface SecureStorageEntry {
  namespace: string
  key: string
  value: string
}

export interface BridgeHttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: unknown
  timeoutMs: number
}

export interface BridgeHttpResponse {
  ok: boolean
  status: number
  body?: unknown
}

export interface ShellTitleBarTheme {
  mode: 'light' | 'dark'
  backgroundColor: string
  symbolColor: string
  height: number
}

export interface ShellWindowState {
  maximized: boolean
  minimized: boolean
  fullscreen: boolean
  focused: boolean
}

export type BridgePermission =
  | 'app:read'
  | 'settings:read'
  | 'settings:write'
  | 'storage:read'
  | 'storage:write'
  | 'diagnostics:write'
  | 'statlog:report'
  | 'shell:read'
  | 'shell:write'
  | 'clipboard:read'
  | 'clipboard:write'
  | 'dialog:open'
  | 'vfs:read'
  | 'vfs:write'
  | 'os:permission'
  | (string & {})

export type BridgeErrorCode =
  | 'bridge.permission_denied'
  | 'bridge.invalid_payload'
  | 'bridge.unsupported_capability'
  | 'bridge.handler_failed'
  | 'bridge.not_registered'
  | (string & {})

export interface BridgeError {
  code: BridgeErrorCode
  message: string
  details?: unknown
}

export interface BridgeRequest<TPayload = unknown> {
  channel: string
  payload: TPayload
  permission?: BridgePermission
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: BridgeError }

export type ShellCapabilityId =
  | 'windows'
  | 'title-bar'
  | 'menus'
  | 'tray'
  | 'menu-bar'
  | 'notifications'
  | 'clipboard'
  | 'native-dialogs'
  | 'protocols'
  | 'file-associations'
  | 'deep-links'
  | 'auto-update'
  | 'secure-storage'
  | 'os-permissions'
  | (string & {})

export interface ShellCapability {
  id: ShellCapabilityId
  supported: boolean
  platforms: PlatformName[]
  permission: BridgePermission
  bridgeMethod: string
  notes?: string
}

export interface DesktopApi {
  app: {
    getInfo(): Promise<ApiResult<AppInfo>>
  }
  shell: {
    getCapabilities(): Promise<ApiResult<ShellCapability[]>>
    getCapability(id: ShellCapabilityId): Promise<ApiResult<ShellCapability>>
    setTitleBarTheme?(theme: ShellTitleBarTheme): Promise<ApiResult<void>>
    getWindowState?(): Promise<ApiResult<ShellWindowState>>
    minimizeWindow?(): Promise<ApiResult<ShellWindowState>>
    toggleMaximizeWindow?(): Promise<ApiResult<ShellWindowState>>
    closeWindow?(): Promise<ApiResult<void>>
  }
  settings: {
    load(): Promise<ApiResult<AppSettings>>
    save(settings: AppSettings): Promise<ApiResult<AppSettings>>
    reset(): Promise<ApiResult<AppSettings>>
  }
  storage: {
    read(namespace: string, key: string): Promise<ApiResult<unknown>>
    write(entry: StorageEntry): Promise<ApiResult<void>>
    remove(namespace: string, key: string): Promise<ApiResult<void>>
  }
  secureStorage?: {
    isAvailable(): Promise<ApiResult<boolean>>
    readSecret(namespace: string, key: string): Promise<ApiResult<string | undefined>>
    writeSecret(entry: SecureStorageEntry): Promise<ApiResult<void>>
    removeSecret(namespace: string, key: string): Promise<ApiResult<void>>
  }
  diagnostics: {
    log(event: DiagnosticEvent): Promise<ApiResult<void>>
  }
  statlog?: {
    request(request: BridgeHttpRequest): Promise<ApiResult<BridgeHttpResponse>>
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  locale: 'en-US',
  accentColor: '#2F6FED',
  telemetryEnabled: false,
  autoUpdateChecks: true
}
