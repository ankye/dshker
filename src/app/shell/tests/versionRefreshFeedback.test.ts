import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const shell = readFileSync(path.join(appRoot, 'src/app/shell/AppShell.vue'), 'utf8')
const controls = readFileSync(path.join(appRoot, 'src/styles/controls.css'), 'utf8')
const routes = readFileSync(path.join(appRoot, 'src/styles/routes.css'), 'utf8')
const stageActions = readFileSync(
  path.join(appRoot, 'src/app/shell/components/VersionStageActions.vue'),
  'utf8'
)
const versionPanel = readFileSync(
  path.join(appRoot, 'src/app/shell/components/VersionManagementPanel.vue'),
  'utf8'
)

describe('version-list refresh feedback', () => {
  it('labels each version-management refresh while the authoritative operation is pending', () => {
    expect(shell).toContain(
      "case 'refresh':\n        return shell.t('status.operation.refreshVersions')"
    )
    expect(shell).toContain(
      "case 'refreshPlugins':\n        return shell.t('status.operation.refreshPlugins')"
    )
    expect(shell).toContain(
      "if (pluginCatalog.loading.value) return shell.t('status.operation.refreshCatalog')"
    )
  })

  it('lets the pending track occupy the available status-bar width', () => {
    const marker = '.statusbar-progress-track {'
    const start = controls.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const block = controls.slice(start + marker.length, controls.indexOf('}', start))

    expect(block).toContain('flex: 1 1 auto')
    expect(block).not.toContain('max-width')
  })

  it('keeps every list refresh in the shared version-stage action area', () => {
    expect(stageActions).toContain('data-testid="refresh-core-versions"')
    expect(stageActions).toContain('data-testid="refresh-installed-plugins"')
    expect(stageActions).toContain('data-testid="refresh-plugin-catalog"')
    expect(stageActions.match(/version-action-button--icon/g)).toHaveLength(3)
    expect(versionPanel).toContain('<VersionStageActions />')
    expect(versionPanel).not.toContain('data-testid="refresh-installed-plugins"')
  })

  it('separates core scope and table-selection actions from list refresh', () => {
    expect(stageActions).not.toContain("t('versions.core.switchBranch')")
    expect(versionPanel).toContain('class="core-scope-actions"')
    expect(versionPanel).toContain('class="core-version-tabs core-version-tabs--content"')
    expect(versionPanel).toContain('data-testid="uninstall-selected-plugins"')
    expect(versionPanel).toContain('data-testid="install-selected-plugins"')
  })

  it('keeps Git and ZIP source installation out of the catalog list plane', () => {
    expect(stageActions).toContain('data-testid="open-git-plugin-install"')
    expect(stageActions).toContain('data-testid="install-plugin-archive"')
    expect(versionPanel).toContain('class="version-install-dialog"')
    expect(versionPanel).not.toContain('class="catalog-source-install-actions"')
    expect(routes).not.toContain('-webkit-line-clamp: 3')
  })

  it('keeps catalog category selection in a vertical sidebar instead of a horizontal tag strip', () => {
    expect(versionPanel).toContain('class="catalog-category-sidebar"')
    expect(versionPanel).toContain('aria-orientation="vertical"')
    expect(routes).toContain('.catalog-category-list {')
    expect(routes).toContain('overflow-y: auto')
    expect(routes).not.toContain('.catalog-category-strip')
    expect(routes).not.toContain('overflow-x: auto')
  })
})
