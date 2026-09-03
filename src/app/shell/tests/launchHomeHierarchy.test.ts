import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const panel = readFileSync(path.join(appRoot, 'src/app/shell/components/LaunchPanel.vue'), 'utf8')
const action = readFileSync(
  path.join(appRoot, 'src/app/shell/components/LaunchPrimaryAction.vue'),
  'utf8'
)
const appShell = readFileSync(path.join(appRoot, 'src/app/shell/AppShell.vue'), 'utf8')
const routeStage = readFileSync(
  path.join(appRoot, 'src/app/shell/components/RouteStage.vue'),
  'utf8'
)
const styles = readFileSync(path.join(appRoot, 'src/styles/routes.css'), 'utf8')
const shellStyles = readFileSync(path.join(appRoot, 'src/styles/base-shell.css'), 'utf8')

describe('launch home hierarchy', () => {
  it('keeps one start action beside an explicit route to version management', () => {
    expect(action).toContain(
      'class="prototype-button prototype-button--primary launch-primary-action"'
    )
    expect(panel).toContain('launch-version-manage')
    expect(panel).toContain("t('launch.version.manage')")
    expect(panel).toContain("@click=\"emit('navigate', 'versions')\"")
  })

  it('gives the launch action its own icon and distinct pending label', () => {
    expect(action).toContain('class="launch-primary-icon"')
    expect(action).toContain("t('launch.starting')")
  })

  it('keeps the launch footer actionable after DSH is running', () => {
    expect(action).toContain("? t('launch.stop')")
    expect(action).toContain('await harness.stop()')
    expect(action).toContain(':disabled="disabled"')
    expect(action).not.toContain(':disabled="!harness.canStart.value"')
  })

  it('keeps the selected core as the only launch-state card', () => {
    expect(styles).toContain('.launch-workbench {')
    expect(styles).toContain('.launch-version-manage {')
    expect(styles).not.toContain('.launch-update-notice {')
  })

  it('keeps the desktop launch action in a RouteStage footer outside the content scroller', () => {
    expect(appShell).toContain('<template #footer>')
    expect(appShell).toContain('<LaunchPrimaryAction />')
    expect(routeStage).toContain('class="route-stage-content"')
    expect(routeStage).toContain('class="route-stage-footer"')
    expect(shellStyles).toContain('.route-stage-content {')
    expect(shellStyles).toContain('overflow-y: auto')
    expect(shellStyles).toContain('.route-stage-footer {')
    expect(shellStyles).not.toContain('.launch-global-action {')
  })
})
