import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
// `app.css` only aggregates @import-ed sheets, so the rules are read from the
// sheets themselves in the same order the entry file imports them.
const styles = ['base-shell', 'routes', 'controls', 'responsive']
  .map((sheet) => readFileSync(path.join(appRoot, `src/styles/${sheet}.css`), 'utf8'))
  .join('\n')
const runtimePanel = readFileSync(
  path.join(appRoot, 'src/app/shell/components/RuntimeTabsPanel.vue'),
  'utf8'
)

/** Returns the declaration block of one exact top-level selector. */
function ruleBlock(selector: string): string {
  const marker = `${selector} {`
  const start = styles.indexOf(marker)
  expect(start, `${selector} must exist in app.css`).toBeGreaterThan(-1)
  const end = styles.indexOf('}', start)
  return styles.slice(start + marker.length, end)
}

function runtimeRuleBlock(selector: string): string {
  const marker = `${selector} {`
  const start = runtimePanel.indexOf(marker)
  expect(start, `${selector} must exist in RuntimeTabsPanel.vue`).toBeGreaterThan(-1)
  const end = runtimePanel.indexOf('}', start)
  return runtimePanel.slice(start + marker.length, end)
}

/**
 * Asserts one CSS declaration is present, normalizing whitespace first.
 *
 * Values are compared as literal text instead of by regular expression. A
 * whitespace-class pattern after a CSS property name would put a letter, a
 * colon, and a backslash next to each other, which the workspace path-hygiene
 * gate reads as a Windows drive prefix.
 */
function hasDeclaration(block: string, property: string, value: string): boolean {
  return block.replace(/\s+/gu, ' ').includes(`${property}: ${value}`)
}

/**
 * Every route must adapt to the window instead of growing the document.
 *
 * These are asserted against the stylesheet rather than a mounted component
 * because jsdom does not lay out or scroll: it reports zero-height boxes, so a
 * DOM-based assertion here would pass regardless of the rules.
 */
describe('shell scroll and height adaptation', () => {
  it('pins the shell to the viewport so chrome cannot be pushed off screen', () => {
    const shell = ruleBlock('.app-shell')

    expect(hasDeclaration(shell, 'height', '100vh')).toBe(true)
    expect(hasDeclaration(shell, 'overflow', 'hidden')).toBe(true)
    // A minimum would let tall content stretch the middle row open.
    expect(hasDeclaration(shell, 'min-height', '100vh')).toBe(false)
  })

  it('keeps the document itself exactly viewport-sized', () => {
    const root = ruleBlock('#app')

    expect(hasDeclaration(root, 'height', '100%')).toBe(true)
    expect(hasDeclaration(root, 'min-height', '100%')).toBe(false)
  })

  it('keeps the stage clipped while route content becomes the vertical scroll container', () => {
    const stage = ruleBlock('.workbench-stage')
    const content = ruleBlock('.route-stage-content')

    expect(hasDeclaration(stage, 'overflow', 'hidden')).toBe(true)
    expect(hasDeclaration(stage, 'min-height', '0')).toBe(true)
    expect(hasDeclaration(content, 'overflow-y', 'auto')).toBe(true)
    expect(hasDeclaration(content, 'min-height', '0')).toBe(true)
  })

  it('keeps each route header fixed while its body scrolls', () => {
    expect(hasDeclaration(ruleBlock('.route-stage-header'), 'flex', '0 0 auto')).toBe(true)
  })

  it('bounds the console log so a long-running child cannot push controls away', () => {
    const log = ruleBlock('.controller-output')

    // The log fills the stage and scrolls inside itself. `min-height: 0` is what
    // keeps the flex child shrinkable, so a long log scrolls instead of growing
    // the route and pushing its controls out of reach.
    expect(hasDeclaration(log, 'flex', '1 1 0')).toBe(true)
    expect(hasDeclaration(log, 'overflow-y', 'auto')).toBe(true)
  })

  it('lets the run frame inherit available height instead of claiming a fixed one', () => {
    expect(hasDeclaration(runtimeRuleBlock('.browser-panel'), 'flex', '1')).toBe(true)
    expect(hasDeclaration(runtimeRuleBlock('.browser-panel'), 'min-height', '0')).toBe(true)
    expect(hasDeclaration(runtimeRuleBlock('.browser-viewport-stack'), 'flex', '1 1 auto')).toBe(
      true
    )
  })

  it('derives no route height from hand-computed viewport arithmetic', () => {
    // `calc(100vh - chrome)` drifts whenever padding or chrome heights change.
    expect(styles.replace(/\s+/gu, ' ')).not.toContain('min-height: calc(100vh')
  })

  it('confines narrow-viewport panning to the horizontal axis', () => {
    const narrow = styles.slice(styles.indexOf('@media (max-width: 720px)'))

    expect(hasDeclaration(narrow, 'overflow-x', 'auto')).toBe(true)
    expect(hasDeclaration(narrow, 'overflow-y', 'hidden')).toBe(true)
  })
})
