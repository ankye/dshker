import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const routes = readFileSync(path.join(appRoot, 'src/styles/routes.css'), 'utf8')
const settingsPanel = readFileSync(
  path.join(appRoot, 'src/app/shell/components/SettingsPanel.vue'),
  'utf8'
)

/** Declaration block of one exact top-level selector in routes.css. */
function ruleBlock(selector: string): string {
  const marker = `${selector} {`
  const start = routes.indexOf(marker)
  expect(start, `${selector} must exist in routes.css`).toBeGreaterThan(-1)
  return routes.slice(start + marker.length, routes.indexOf('}', start))
}

/**
 * Settings used a 56rem centered column while every other route filled the
 * stage, so it sat in ~120px of dead margin on both sides and looked unrelated
 * to the rest of the app.
 */
describe('settings route layout', () => {
  it('fills the stage instead of centering a narrow fixed-width column', () => {
    const block = ruleBlock('.settings-panel')
    expect(block).toContain('width: 100%')
    expect(block).not.toContain('max-width')
    expect(block).not.toContain('margin-inline: auto')
  })

  it('shares the route padding that every other panel uses', () => {
    // .settings-panel is part of the grouped per-route surface rule.
    const grouped = routes.slice(0, routes.indexOf('.launch-hero'))
    expect(grouped).toContain('.settings-panel')
  })

  it('renders each section as one card, so header and body share a surface', () => {
    const block = ruleBlock('.settings-section')
    expect(block).toContain('border:')
    expect(block).toContain('border-radius:')
    expect(block).toContain('background:')
  })

  it('separates rows with rules rather than nesting a card inside each card', () => {
    const block = ruleBlock('.settings-row')
    expect(block).not.toContain('border-radius')
    expect(block).not.toContain('background:')
    expect(routes).toContain('.settings-row + .settings-row')
  })

  it('places the two launcher sections side by side once the stage is wide', () => {
    expect(routes).toContain('.settings-tab-panel--split')
    expect(settingsPanel).toContain('settings-tab-panel--split')
  })

  it('keeps application updates visible across the full launcher settings width', () => {
    expect(settingsPanel).toContain('<LauncherUpdateSettingsCard />')
    expect(ruleBlock('.settings-update-section')).toContain('grid-column: 1 / -1')
  })
})
