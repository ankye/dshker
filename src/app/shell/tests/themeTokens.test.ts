import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const tokens = readFileSync(path.join(appRoot, 'src/styles/tokens.css'), 'utf8')
const styles = ['base-shell', 'routes', 'controls', 'responsive']
  .map((sheet) => readFileSync(path.join(appRoot, `src/styles/${sheet}.css`), 'utf8'))
  .join('\n')

/** Declaration block of one exact top-level selector. */
function ruleBlock(selector: string): string {
  const marker = `${selector} {`
  const start = tokens.indexOf(marker)
  expect(start, `${selector} must exist in tokens.css`).toBeGreaterThan(-1)
  return tokens.slice(start + marker.length, tokens.indexOf('}', start))
}

function customProperties(block: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>()
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gu)) {
    found.set(match[1], match[2].trim())
  }
  return found
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
  )
  const [r, g, b] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** Every colour role a theme must define for itself. */
const THEME_COLOUR_ROLES = [
  '--color-bg',
  '--color-surface',
  '--color-surface-raised',
  '--color-surface-muted',
  '--color-border',
  '--color-text',
  '--color-text-muted',
  '--color-accent',
  '--color-success',
  '--color-warning',
  '--color-danger',
  '--color-focus',
  '--color-on-accent'
] as const

const darkTheme = customProperties(ruleBlock(':root'))
const lightTheme = customProperties(ruleBlock(":root[data-theme='light']"))

/**
 * Theme completeness, asserted against the stylesheet because jsdom does not
 * resolve custom properties or compute colour.
 *
 * The regression this pins: the light theme overrode only its greys and
 * inherited the dark theme's accent, success, warning, danger, and focus
 * colours. Those hues measured between 1.5:1 and 2.5:1 on a white surface while
 * carrying status text, error text, and state icons, so the information they
 * encoded was unreadable in that theme.
 */
describe('theme token completeness', () => {
  it.each([
    ['dark', darkTheme],
    ['light', lightTheme]
  ])('defines every colour role in the %s theme', (_name, theme) => {
    for (const role of THEME_COLOUR_ROLES) {
      expect(theme.has(role), `${role} must be defined by this theme`).toBe(true)
    }
  })

  it('gives each theme its own focus ring rather than sharing one', () => {
    expect(darkTheme.has('--focus-ring')).toBe(true)
    expect(lightTheme.has('--focus-ring')).toBe(true)
    expect(lightTheme.get('--focus-ring')).not.toBe(darkTheme.get('--focus-ring'))
  })

  /**
   * Semantic hues must be theme-specific. Identical values across both themes
   * are the exact defect that made light-theme status text unreadable.
   */
  it.each(['--color-accent', '--color-success', '--color-warning', '--color-danger'])(
    'tunes %s separately per theme',
    (role) => {
      expect(lightTheme.get(role)).not.toBe(darkTheme.get(role))
    }
  )

  it.each([
    ['dark', darkTheme],
    ['light', lightTheme]
  ])('keeps %s semantic colours readable on every surface of that theme', (_name, theme) => {
    const surfaces = [
      theme.get('--color-bg'),
      theme.get('--color-surface'),
      theme.get('--color-surface-raised'),
      theme.get('--color-surface-muted')
    ]

    for (const role of ['--color-accent', '--color-success', '--color-warning', '--color-danger']) {
      const colour = theme.get(role)
      expect(colour, `${role} must be defined`).toBeDefined()
      for (const surface of surfaces) {
        expect(surface).toBeDefined()
        const ratio = contrastRatio(colour as string, surface as string)
        // These roles carry status text and state icons, not decoration.
        expect(
          ratio,
          `${role} on ${surface as string} is ${ratio.toFixed(2)}:1, below the 4.5:1 text minimum`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it.each([
    ['dark', darkTheme],
    ['light', lightTheme]
  ])('keeps %s body and muted text readable on every surface', (_name, theme) => {
    const surfaces = [
      theme.get('--color-surface'),
      theme.get('--color-surface-raised'),
      theme.get('--color-surface-muted'),
      theme.get('--color-bg')
    ]

    for (const role of ['--color-text', '--color-text-muted']) {
      for (const surface of surfaces) {
        const ratio = contrastRatio(theme.get(role) as string, surface as string)
        expect(
          ratio,
          `${role} on ${surface as string} is ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  /** Text on an accent fill must follow the theme, not a fixed near-black. */
  it.each([
    ['dark', darkTheme],
    ['light', lightTheme]
  ])('pairs %s on-accent text with that theme accent', (_name, theme) => {
    const ratio = contrastRatio(
      theme.get('--color-on-accent') as string,
      theme.get('--color-accent') as string
    )
    expect(ratio, `on-accent contrast is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
  })

  it('resolves accent-filled controls through the token instead of a literal', () => {
    expect(styles.includes('#08101b'), 'a hard-coded on-accent literal ignores the theme').toBe(
      false
    )
    expect(styles.includes('color: var(--color-on-accent)')).toBe(true)
  })
})
