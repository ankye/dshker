import type {
  ApiResult,
  BridgeErrorCode,
  BridgePermission,
  DesktopApi,
  PlatformName,
  ShellCapability,
  ShellCapabilityId
} from './contracts'

declare global {
  interface Window {
    desktopApi: DesktopApi
  }
}

export type BridgeArgValidator = (value: unknown, index: number) => string | undefined
export type BridgeFailureResult = Extract<ApiResult<unknown>, { ok: false }>
export type BridgeHandler<T = unknown> = (...args: unknown[]) => T | Promise<T>
export type BridgeInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>
export type BridgeRegister = (
  channel: string,
  handler: (...args: unknown[]) => Promise<ApiResult<unknown>>
) => void

export interface BridgeHandlerDefinition<T = unknown> {
  channel: string
  permission?: BridgePermission
  validate?: BridgeArgValidator[]
  handle: BridgeHandler<T>
}

export interface BridgeHandlerContext {
  permissions?: readonly BridgePermission[]
  diagnostics?: (event: {
    level: 'debug' | 'info' | 'warn' | 'error'
    message: string
    context?: Record<string, unknown>
  }) => void
}

export interface PlatformAdapter {
  platform: PlatformName
  capabilities: ShellCapability[]
}

const SECRET_KEYS = /(api[-_]?key|token|secret|password|credential|authorization)/i

export const bridgeValidators = {
  string(value: unknown, index: number): string | undefined {
    return typeof value === 'string' ? undefined : `Argument ${index} must be a string.`
  },
  nonEmptyString(value: unknown, index: number): string | undefined {
    return typeof value === 'string' && value.trim() !== ''
      ? undefined
      : `Argument ${index} must be a non-empty string.`
  },
  object(value: unknown, index: number): string | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? undefined
      : `Argument ${index} must be an object.`
  },
  boolean(value: unknown, index: number): string | undefined {
    return typeof value === 'boolean' ? undefined : `Argument ${index} must be a boolean.`
  }
}

export const DEFAULT_SHELL_CAPABILITIES: ShellCapability[] = [
  {
    id: 'windows',
    supported: true,
    platforms: ['darwin', 'win32', 'linux'],
    permission: 'app:read',
    bridgeMethod: 'app.getInfo',
    notes: 'Window lifecycle stays in the Electron main process.'
  },
  {
    id: 'title-bar',
    supported: true,
    platforms: ['darwin', 'win32', 'linux'],
    permission: 'shell:write',
    bridgeMethod: 'shell.setTitleBarTheme',
    notes:
      'Window chrome theming stays in the shell adapter; Windows and Linux use renderer-owned controls through shell window commands.'
  },
  {
    id: 'menus',
    supported: true,
    platforms: ['darwin', 'win32', 'linux'],
    permission: 'shell:read',
    bridgeMethod: 'shell.getCapability'
  },
  {
    id: 'tray',
    supported: true,
    platforms: ['darwin', 'win32', 'linux'],
    permission: 'shell:read',
    bridgeMethod: 'shell.getCapability'
  },
  {
    id: 'menu-bar',
    supported: true,
    platforms: ['darwin'],
    permission: 'shell:read',
    bridgeMethod: 'shell.getCapability',
    notes: 'Menu bar behavior is macOS-first; Windows should use tray or menu commands.'
  },
  {
    id: 'notifications',
    supported: true,
    platforms: ['darwin', 'win32'],
    permission: 'os:permission',
    bridgeMethod: 'shell.getCapability'
  },
  {
    id: 'clipboard',
    supported: true,
    platforms: ['darwin', 'win32', 'linux'],
    permission: 'clipboard:read',
    bridgeMethod: 'shell.getCapability'
  },
  {
    id: 'native-dialogs',
    supported: true,
    platforms: ['darwin', 'win32', 'linux'],
    permission: 'dialog:open',
    bridgeMethod: 'shell.getCapability'
  },
  {
    id: 'protocols',
    supported: true,
    platforms: ['darwin', 'win32'],
    permission: 'shell:read',
    bridgeMethod: 'shell.getCapability'
  },
  {
    id: 'file-associations',
    supported: true,
    platforms: ['darwin', 'win32'],
    permission: 'shell:read',
    bridgeMethod: 'shell.getCapability'
  },
  {
    id: 'deep-links',
    supported: true,
    platforms: ['darwin', 'win32'],
    permission: 'shell:read',
    bridgeMethod: 'shell.getCapability'
  },
  {
    id: 'auto-update',
    supported: true,
    platforms: ['darwin', 'win32'],
    permission: 'shell:read',
    bridgeMethod: 'shell.getCapability',
    notes: 'Signing and publishing credentials remain outside app source.'
  },
  {
    id: 'secure-storage',
    supported: true,
    platforms: ['darwin', 'win32'],
    permission: 'shell:read',
    bridgeMethod: 'shell.getCapability'
  },
  {
    id: 'os-permissions',
    supported: true,
    platforms: ['darwin', 'win32'],
    permission: 'os:permission',
    bridgeMethod: 'shell.getCapability'
  }
]

export function getDesktopApi(): DesktopApi | undefined {
  return typeof window === 'undefined' ? undefined : window.desktopApi
}

export function bridgeOk<T>(data: T): ApiResult<T> {
  return { ok: true, data }
}

export function bridgeFail<T = never>(
  code: BridgeErrorCode,
  message: string,
  details?: unknown
): Extract<ApiResult<T>, { ok: false }> {
  return {
    ok: false,
    error: { code, message, details: redactBridgeDetails(details) }
  }
}

export function redactBridgeDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBridgeDetails)

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      output[key] = SECRET_KEYS.test(key) ? '[redacted]' : redactBridgeDetails(nested)
    }
    return output
  }

  if (typeof value === 'string' && /[A-Za-z0-9_-]{32,}/.test(value)) return '[redacted]'
  return value
}

export function mapBridgeError(
  error: unknown,
  fallbackCode: BridgeErrorCode = 'bridge.handler_failed'
): BridgeFailureResult {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const typed = error as {
      code: BridgeErrorCode
      message: string
      details?: unknown
    }
    return bridgeFail(typed.code, typed.message, typed.details)
  }

  const message = error instanceof Error ? error.message : 'Bridge handler failed.'
  return bridgeFail(fallbackCode, message)
}

export function hasBridgePermission(
  grants: readonly BridgePermission[] | undefined,
  permission: BridgePermission | undefined
): boolean {
  if (!permission) return true
  if (!grants?.length) return false
  return grants.includes(permission) || grants.includes('*')
}

export function requireBridgePermission(
  grants: readonly BridgePermission[] | undefined,
  permission: BridgePermission | undefined
): ApiResult<void> {
  if (hasBridgePermission(grants, permission)) return bridgeOk(undefined)
  return bridgeFail('bridge.permission_denied', `Missing bridge permission: ${permission || ''}`)
}

export function validateBridgeArgs(
  args: readonly unknown[],
  validators: readonly BridgeArgValidator[] = []
): ApiResult<void> {
  for (let index = 0; index < validators.length; index += 1) {
    const message = validators[index](args[index], index)
    if (message) return bridgeFail('bridge.invalid_payload', message, { index })
  }
  return bridgeOk(undefined)
}

export function createPreloadBridge<T extends object>(
  api: T,
  expose: (key: string, value: T) => void,
  key = 'desktopApi'
): T {
  expose(key, api)
  return api
}

export async function invokeBridge<T>(
  invoke: BridgeInvoke,
  channel: string,
  ...args: unknown[]
): Promise<ApiResult<T>> {
  try {
    const result = await invoke(channel, ...args)
    return result && typeof result === 'object' && 'ok' in result
      ? (result as ApiResult<T>)
      : bridgeOk(result as T)
  } catch (error) {
    return mapBridgeError(error)
  }
}

export function registerBridgeHandlers(
  register: BridgeRegister,
  handlers: readonly BridgeHandlerDefinition[],
  context: BridgeHandlerContext = {}
): void {
  for (const definition of handlers) {
    register(definition.channel, async (...args) => {
      const permission = requireBridgePermission(context.permissions, definition.permission)
      if (!permission.ok) return permission

      const validation = validateBridgeArgs(args, definition.validate)
      if (!validation.ok) return validation

      try {
        return bridgeOk(await definition.handle(...args))
      } catch (error) {
        const result = mapBridgeError(error)
        context.diagnostics?.({
          level: 'warn',
          message: 'Bridge handler failed.',
          context: {
            channel: definition.channel,
            code: result.error.code,
            details: result.error.details
          }
        })
        return result
      }
    })
  }
}

export function createShellCapabilityRegistry(
  platform: PlatformName,
  overrides: Partial<Record<ShellCapabilityId, Partial<ShellCapability>>> = {}
): ShellCapability[] {
  return DEFAULT_SHELL_CAPABILITIES.map((capability) => {
    const override = overrides[capability.id] || {}
    const platforms = override.platforms || capability.platforms
    return {
      ...capability,
      ...override,
      platforms,
      supported: Boolean(
        (override.supported ?? capability.supported) && platforms.includes(platform)
      )
    }
  })
}

export function getShellCapability(
  registry: readonly ShellCapability[],
  id: ShellCapabilityId
): ApiResult<ShellCapability> {
  const capability = registry.find((entry) => entry.id === id)
  if (!capability) {
    return bridgeFail('bridge.unsupported_capability', `Unsupported shell capability: ${id}`, {
      id
    })
  }
  return bridgeOk(capability)
}

export function createPlatformAdapter(
  platform: PlatformName,
  overrides?: Partial<Record<ShellCapabilityId, Partial<ShellCapability>>>
): PlatformAdapter {
  return {
    platform,
    capabilities: createShellCapabilityRegistry(platform, overrides)
  }
}

export async function callPlatformCapability<T>(
  adapter: PlatformAdapter,
  id: ShellCapabilityId,
  handler: () => T | Promise<T>
): Promise<ApiResult<T>> {
  const capability = getShellCapability(adapter.capabilities, id)
  if (!capability.ok) return capability
  if (!capability.data.supported) {
    return bridgeFail('bridge.unsupported_capability', `Shell capability is unavailable: ${id}`, {
      id,
      platform: adapter.platform
    })
  }

  try {
    return bridgeOk(await handler())
  } catch (error) {
    return mapBridgeError(error)
  }
}
