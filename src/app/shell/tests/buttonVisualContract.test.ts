import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The button base class shipped without a surface of its own, so 41 buttons
 * across 12 panels fell back to the user-agent grey rgb(107 107 107) — a value
 * the token system does not contain. Primary and secondary actions were
 * indistinguishable and nothing matched the dark surfaces around them.
 *
 * The destructive variant was referenced in seven places and never defined at
 * all, so deleting a network looked exactly like reading one.
 */
describe('button visual contract', () => {
  const css = readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'styles', 'routes.css'),
    'utf8'
  )
  const rule = (selector: string): string => {
    const start = css.indexOf(selector + ' {')
    expect(start, selector + ' must be defined').toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('}', start))
  }

  it('gives the base control a token surface instead of the user-agent default', () => {
    const base = rule('.prototype-button')
    expect(base).toContain('background: var(--color-surface-raised)')
    expect(base).toContain('color: var(--color-text)')
    // A bare colour here would sit outside the theme and break on a light theme.
    expect(base).not.toMatch(/background:\s*(#|rgb)/)
  })

  it('defines every variant the templates actually apply', () => {
    // A referenced but undefined variant renders as the base control, which is
    // how destructive actions lost their warning.
    for (const variant of ['--primary', '--danger']) {
      expect(css).toContain('.prototype-button' + variant + ' {')
    }
  })

  it('separates a destructive action from an ordinary one', () => {
    const danger = rule('.prototype-button--danger')
    expect(danger).toContain('var(--color-danger)')
  })

  it('keeps keyboard focus visible on filled variants', () => {
    // A border-only focus treatment disappears against a filled button.
    const focus = rule('.prototype-button:focus-visible')
    expect(focus).toContain('outline')
    expect(focus).toContain('var(--color-focus)')
  })
})
