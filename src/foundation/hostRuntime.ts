/** Renderer host facts used only to explain bootstrap admission. */
export interface HostRuntime {
  readonly kind: 'electron' | 'web-preview'
  readonly bridgeAvailable: boolean
}

/** Detects whether the typed preload capability is present. */
export function detectHostRuntime(): HostRuntime {
  return window.dshLauncher
    ? { kind: 'electron', bridgeAvailable: true }
    : { kind: 'web-preview', bridgeAvailable: false }
}
