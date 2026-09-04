/** Guest rendering facts returned by the fixed, read-only WebView probe. */
export interface RuntimeGuestRenderingInfo {
  readonly devicePixelRatio: number
  readonly visualViewportScale: number | null
  readonly colorScheme: 'dark' | 'light'
  readonly rootBackgroundColor: string
  readonly bodyBackgroundColor: string | null
  readonly textColor: string | null
  readonly fontFamily: string | null
  readonly fontSize: string | null
  readonly fontSmoothing: string | null
}

/**
 * Fixed diagnostic probe for an admitted DSH Web guest.
 *
 * It intentionally never reads location, cookies, storage, document text, or
 * network state, so the child-announced credential cannot enter diagnostics.
 */
export const RUNTIME_GUEST_RENDERING_PROBE = `(() => {
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body === null ? null : getComputedStyle(document.body);
  return {
    devicePixelRatio: window.devicePixelRatio,
    visualViewportScale: window.visualViewport === null ? null : window.visualViewport.scale,
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    rootBackgroundColor: rootStyle.backgroundColor,
    bodyBackgroundColor: bodyStyle === null ? null : bodyStyle.backgroundColor,
    textColor: bodyStyle === null ? null : bodyStyle.color,
    fontFamily: bodyStyle === null ? null : bodyStyle.fontFamily,
    fontSize: bodyStyle === null ? null : bodyStyle.fontSize,
    fontSmoothing: bodyStyle === null ? null : bodyStyle.getPropertyValue('-webkit-font-smoothing')
  };
})()`

/** Strictly validates every guest probe field before the Launcher displays or copies it. */
export function parseRuntimeGuestRenderingInfo(value: unknown): RuntimeGuestRenderingInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Runtime guest rendering diagnostics must be an object.')
  }
  const record = value as Record<string, unknown>
  const expected = [
    'devicePixelRatio',
    'visualViewportScale',
    'colorScheme',
    'rootBackgroundColor',
    'bodyBackgroundColor',
    'textColor',
    'fontFamily',
    'fontSize',
    'fontSmoothing'
  ]
  if (
    Object.keys(record).length !== expected.length ||
    Object.keys(record).some((key) => !expected.includes(key))
  ) {
    throw new Error('Runtime guest rendering diagnostic fields are invalid.')
  }
  if (
    !isPositiveNumber(record.devicePixelRatio) ||
    (record.visualViewportScale !== null && !isPositiveNumber(record.visualViewportScale))
  ) {
    throw new Error('Runtime guest rendering scale values are invalid.')
  }
  if (record.colorScheme !== 'dark' && record.colorScheme !== 'light') {
    throw new Error('Runtime guest rendering color scheme is invalid.')
  }
  if (typeof record.rootBackgroundColor !== 'string') {
    throw new Error('Runtime guest rendering rootBackgroundColor is invalid.')
  }
  const nullableStringKeys = [
    'bodyBackgroundColor',
    'textColor',
    'fontFamily',
    'fontSize',
    'fontSmoothing'
  ] as const
  for (const key of nullableStringKeys) {
    if (record[key] !== null && typeof record[key] !== 'string') {
      throw new Error(`Runtime guest rendering ${key} is invalid.`)
    }
  }
  return {
    devicePixelRatio: record.devicePixelRatio,
    visualViewportScale: record.visualViewportScale,
    colorScheme: record.colorScheme,
    rootBackgroundColor: record.rootBackgroundColor,
    bodyBackgroundColor: readNullableString(record, 'bodyBackgroundColor'),
    textColor: readNullableString(record, 'textColor'),
    fontFamily: readNullableString(record, 'fontFamily'),
    fontSize: readNullableString(record, 'fontSize'),
    fontSmoothing: readNullableString(record, 'fontSmoothing')
  }
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (value !== null && typeof value !== 'string') {
    throw new Error(`Runtime guest rendering ${key} is invalid.`)
  }
  return value
}
