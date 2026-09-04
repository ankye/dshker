import {
  RUNTIME_BROWSER_DEFAULT_ZOOM_PERCENT,
  RUNTIME_BROWSER_ZOOM_PERCENTAGES,
  type RuntimeBrowserZoomPercent
} from './contracts'

/** The three page-zoom commands admitted from browser chrome and keyboard input. */
export type RuntimeBrowserZoomCommand = 'decrease' | 'increase' | 'reset'

/** Keyboard fields needed to recognize standard browser zoom shortcuts. */
export interface RuntimeBrowserZoomInput {
  readonly type: string
  readonly key: string
  readonly code: string
  readonly isComposing: boolean
  readonly control: boolean
  readonly alt: boolean
  readonly meta: boolean
}

/** Narrows an external number to one product-defined page-zoom step. */
export function isRuntimeBrowserZoomPercent(value: unknown): value is RuntimeBrowserZoomPercent {
  return (
    typeof value === 'number' &&
    RUNTIME_BROWSER_ZOOM_PERCENTAGES.some((candidate) => candidate === value)
  )
}

/** Resolves one bounded adjacent page-zoom step or the explicit 100% reset. */
export function nextRuntimeBrowserZoom(
  current: RuntimeBrowserZoomPercent,
  command: RuntimeBrowserZoomCommand
): RuntimeBrowserZoomPercent {
  if (command === 'reset') return RUNTIME_BROWSER_DEFAULT_ZOOM_PERCENT
  const currentIndex = RUNTIME_BROWSER_ZOOM_PERCENTAGES.indexOf(current)
  const offset = command === 'increase' ? 1 : -1
  const nextIndex = Math.max(
    0,
    Math.min(RUNTIME_BROWSER_ZOOM_PERCENTAGES.length - 1, currentIndex + offset)
  )
  return RUNTIME_BROWSER_ZOOM_PERCENTAGES[nextIndex]!
}

/**
 * Recognizes the browser zoom shortcuts for the current desktop platform.
 *
 * The host renderer and an attached guest use the same parser so focus does
 * not change the shortcut meaning.
 */
export function runtimeBrowserZoomCommandForInput(
  input: RuntimeBrowserZoomInput,
  platform: NodeJS.Platform
): RuntimeBrowserZoomCommand | undefined {
  if (input.type !== 'keyDown' || input.isComposing || input.alt) return undefined
  const expectedModifier =
    platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (!expectedModifier) return undefined
  if (input.key === '+' || input.key === '=' || input.code === 'NumpadAdd') return 'increase'
  if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') return 'decrease'
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') return 'reset'
  return undefined
}
