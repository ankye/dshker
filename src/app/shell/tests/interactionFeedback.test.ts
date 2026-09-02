import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

function sheet(name: string): string {
  return readFileSync(path.join(appRoot, `src/styles/${name}.css`), 'utf8')
}

const styles = ['base-shell', 'routes', 'controls', 'responsive'].map(sheet).join('\n')
const tokens = sheet('tokens')

/**
 * Interaction feedback and the reduced-motion contract.
 *
 * Asserted against the stylesheets because jsdom neither animates nor lays out:
 * a DOM-based assertion would pass whether or not the rules exist.
 */
describe('motion and interaction feedback', () => {
  it('defines motion durations as tokens so one place governs pacing', () => {
    for (const token of ['--motion-instant', '--motion-fast', '--motion-emphasis']) {
      expect(tokens.includes(`${token}:`), `${token} must be defined`).toBe(true)
    }
  })

  /**
   * The regression this pins: the preference block previously set only
   * `scroll-behavior`, so the indeterminate progress animation kept looping for
   * users who asked for no motion.
   */
  it('actually stops animation and transition under prefers-reduced-motion', () => {
    const start = tokens.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(start, 'a reduced-motion block must exist').toBeGreaterThan(-1)
    const block = tokens.slice(start)

    expect(block.includes('animation-duration: 1ms !important')).toBe(true)
    expect(block.includes('animation-iteration-count: 1 !important')).toBe(true)
    expect(block.includes('transition-duration: 1ms !important')).toBe(true)
  })

  it('gives the primary button hover and press feedback', () => {
    expect(styles.includes('.prototype-button:hover:not(:disabled)')).toBe(true)
    expect(styles.includes('.prototype-button:active:not(:disabled)')).toBe(true)
  })

  /**
   * `cursor: wait` on every disabled button claimed an operation was in flight
   * when usually nothing was running.
   */
  it('reserves the waiting cursor for an operation that is genuinely running', () => {
    const marker = '.prototype-button:disabled {'
    const start = styles.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const block = styles.slice(start + marker.length, styles.indexOf('}', start))

    expect(block.includes('not-allowed')).toBe(true)
    expect(block.includes('wait')).toBe(false)
    expect(styles.includes(".prototype-button[aria-busy='true']")).toBe(true)
  })

  it('gives navigation transitions and a press state', () => {
    const marker = '.nav-item {'
    const start = styles.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const block = styles.slice(start + marker.length, styles.indexOf('}', start))

    expect(block.includes('transition')).toBe(true)
    expect(styles.includes('.nav-item:active:not(:disabled)')).toBe(true)
  })

  /** Every route animates on entry, including the one that skips RouteStage. */
  it('animates route entry on both the staged routes and the run route', () => {
    expect(styles.includes('@keyframes route-enter')).toBe(true)
    for (const selector of ['.route-stage {', '.runtime-route {']) {
      const start = styles.indexOf(selector)
      expect(start, `${selector} must exist`).toBeGreaterThan(-1)
      const block = styles.slice(start + selector.length, styles.indexOf('}', start))
      expect(block.includes('route-enter'), `${selector} must animate on entry`).toBe(true)
    }
  })
})

/**
 * Empty surfaces must come from the shared component. Private per-route classes
 * are what made the same condition look different on three routes.
 */
describe('empty state consolidation', () => {
  it('keeps no route-private empty styles in the stylesheets', () => {
    for (const legacy of [
      '.launch-empty',
      '.controller-empty',
      '.runtime-empty',
      '.usage-empty',
      '.source-panel-empty'
    ]) {
      expect(styles.includes(legacy), `${legacy} must not be reintroduced`).toBe(false)
    }
  })

  it('defines the shared empty surface with a fill variant', () => {
    expect(styles.includes('.empty-state {')).toBe(true)
    expect(styles.includes(".empty-state[data-fill='true']")).toBe(true)
  })
})
