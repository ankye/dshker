#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viewportMatrix = [
  { id: 'narrow', width: 620, height: 900 },
  { id: 'compact', width: 760, height: 560 },
  { id: 'standard', width: 1240, height: 820 },
  { id: 'wide', width: 1600, height: 1000 }
]

function parseArgs(argv) {
  return { json: argv.includes('--json'), help: argv.includes('--help') }
}

// `app.css` is an aggregate of @import-ed sheets, so the layout assertions below
// need the concatenated rules rather than the entry file's import list.
const STYLE_SHEETS = [
  'src/styles/base-shell.css',
  'src/styles/routes.css',
  'src/styles/controls.css',
  'src/styles/responsive.css'
]

async function readSources(root) {
  const files = [
    'src/app/shell/AppShell.vue',
    'src/app/shell/components/ShellSidebar.vue',
    'src/app/shell/components/RuntimeTabsPanel.vue',
    'src/app/shell/components/SettingsPanel.vue',
    'src/app/shell/components/VersionManagementPanel.vue',
    'src/app/shared/controls/ThemedListbox.vue',
    'electron/main/window.ts',
    'src/styles/tokens.css',
    'src/app/shared/i18n/i18n.ts'
  ]
  const [entries, styleSources] = await Promise.all([
    Promise.all(
      files.map(async (relativePath) => ({
        relativePath,
        source: await readFile(path.join(root, relativePath), 'utf8')
      }))
    ),
    Promise.all(STYLE_SHEETS.map((sheet) => readFile(path.join(root, sheet), 'utf8')))
  ])
  return [...entries, { relativePath: 'src/styles/app.css', source: styleSources.join('\n') }]
}

function finding(name, ok) {
  return { name, ok, severity: 'error' }
}

function evaluateSources(sources) {
  const sourceByPath = new Map(sources.map((entry) => [entry.relativePath, entry.source]))
  const shell = sourceByPath.get('src/app/shell/AppShell.vue')
  const sidebar = sourceByPath.get('src/app/shell/components/ShellSidebar.vue')
  const runtimePanel = sourceByPath.get('src/app/shell/components/RuntimeTabsPanel.vue')
  const electronWindow = sourceByPath.get('electron/main/window.ts')
  const settingsPanel = sourceByPath.get('src/app/shell/components/SettingsPanel.vue')
  const versionPanel = sourceByPath.get('src/app/shell/components/VersionManagementPanel.vue')
  const listbox = sourceByPath.get('src/app/shared/controls/ThemedListbox.vue')
  const tokens = sourceByPath.get('src/styles/tokens.css')
  const styles = sourceByPath.get('src/styles/app.css')
  const locales = sourceByPath.get('src/app/shared/i18n/i18n.ts')

  const flatStyles = styles.replace(/\s+/gu, ' ')
  const flatRuntimePanel = runtimePanel.replace(/\s+/gu, ' ')
  // Declarations are compared as literal text rather than by regular expression.
  // A whitespace-class pattern after a CSS property name would put a letter, a
  // colon, and a backslash next to each other, which the workspace path-hygiene
  // gate reads as a Windows drive prefix.
  const block = (selector) => {
    const marker = `${selector} {`
    const start = flatStyles.indexOf(marker)
    if (start < 0) return ''
    return flatStyles.slice(start + marker.length, flatStyles.indexOf('}', start))
  }
  const declared = (selector, property, value) => block(selector).includes(`${property}: ${value}`)
  const runtimeBlock = (selector) => {
    const marker = `${selector} {`
    const start = flatRuntimePanel.indexOf(marker)
    if (start < 0) return ''
    return flatRuntimePanel.slice(start + marker.length, flatRuntimePanel.indexOf('}', start))
  }

  return [
    // Shell chrome: the sidebar carries the brand, and a status bar anchors the
    // bottom. There is deliberately no full-width identity row.
    finding(
      'shell.sidebar-brand',
      sidebar.includes('sidebar-brand') && styles.includes('.sidebar-brand')
    ),
    finding('shell.no-full-width-topbar', !styles.includes('.topbar')),
    finding('shell.sidebar-toggle', shell.includes("t('nav.collapse')")),
    finding('shell.route-navigation', shell.includes("t('versions.title')")),
    finding('shell.no-seeded-workspace', !shell.includes('templateShellData')),

    // A run page may show only the URL the started process announced.
    finding('runtime.no-hardcoded-url', !runtimePanel.includes('127.0.0.1:3080')),
    finding('runtime.announced-url-only', runtimePanel.includes('runtimeUrl')),
    finding(
      'runtime.zoom-controls',
      runtimePanel.includes('runtime-zoom-decrease') &&
        runtimePanel.includes('runtime-zoom-reset') &&
        runtimePanel.includes('runtime-zoom-increase') &&
        runtimePanel.includes('setZoomFactor')
    ),
    finding(
      'runtime.full-bleed-guest',
      runtimeBlock('.browser-viewport-stack').includes('flex: 1 1 auto') &&
        !runtimeBlock('.browser-viewport-stack').includes('margin:') &&
        !runtimeBlock('.browser-viewport-stack').includes('border:') &&
        !runtimeBlock('.browser-viewport-stack').includes('border-radius:')
    ),
    finding(
      'runtime.no-raster-css-effects',
      ['filter:', 'opacity:', 'transform:', 'zoom:'].every(
        (property) => !runtimeBlock('.browser-viewport').includes(property)
      )
    ),
    finding(
      'runtime.no-forced-device-scale-factor',
      !runtimePanel.includes('force-device-scale-factor') &&
        !electronWindow.includes('force-device-scale-factor')
    ),

    // Themed controls replace native select popups that cannot be palette-styled.
    finding('controls.themed-listbox', listbox.includes('role="listbox"')),
    finding('controls.no-native-select', !settingsPanel.includes('<select')),
    finding('controls.checkbox-state', versionPanel.includes('type="checkbox"')),

    // Theme and viewport coverage.
    finding('tokens.dark-operational-palette', tokens.includes('--color-bg: #121820')),
    finding('tokens.light-theme', tokens.includes("[data-theme='light']")),
    finding('tokens.stable-layout', tokens.includes('--layout-sidebar-width')),
    finding(
      'layout.stable-shell-grid',
      declared('.app-shell', 'grid-template-rows', 'minmax(0, 1fr) var(--layout-statusbar-height)')
    ),
    finding('layout.compact-viewport', styles.includes('@media (max-width: 980px)')),
    finding('layout.narrow-viewport', styles.includes('@media (max-width: 720px)')),

    // Window-height adaptation: the shell is pinned to the viewport. A route
    // owns its scrollable content plane, so its header and optional footer
    // remain reachable while the route body grows.
    finding('layout.shell-pinned-to-viewport', declared('.app-shell', 'height', '100vh')),
    finding(
      'layout.route-content-scrolls',
      declared('.workbench-stage', 'min-height', '0') &&
        declared('.workbench-stage', 'overflow', 'hidden') &&
        declared('.route-stage-content', 'min-height', '0') &&
        declared('.route-stage-content', 'overflow-y', 'auto')
    ),
    finding(
      'layout.console-log-bounded',
      // Fills the stage and scrolls internally; `min-height: 0` is what keeps a
      // long log from growing the route instead of scrolling.
      declared('.controller-output', 'flex', '1 1 0') &&
        declared('.controller-output', 'overflow-y', 'auto')
    ),
    finding('layout.no-hand-computed-route-height', !flatStyles.includes('min-height: calc(100vh')),

    finding('locale.chinese-copy', locales.includes("'zh-CN'")),
    finding('locale.english-copy', locales.includes("'en-US'"))
  ]
}

async function writeEvidence(result, root) {
  const outputDirectory = path.join(root, '.run', 'visual-smoke')
  await mkdir(outputDirectory, { recursive: true })
  const evidence = {
    ...result,
    viewportMatrix,
    rendererCaptureCommand: 'npm run electron:renderer-smoke',
    checkedAt: new Date().toISOString()
  }
  await writeFile(
    path.join(outputDirectory, 'latest.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    'utf8'
  )
  return evidence
}

export async function runVisualSmoke(root = appRoot) {
  const findings = evaluateSources(await readSources(root))
  const errors = findings.filter((entry) => !entry.ok)
  return writeEvidence(
    {
      ok: errors.length === 0,
      errors,
      findings
    },
    root
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('Usage: node tools/visual-smoke.mjs [--json]')
    return
  }
  const result = await runVisualSmoke()
  console.log(args.json ? JSON.stringify(result, null, 2) : JSON.stringify(result))
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('visual-smoke: ' + error.message)
    process.exitCode = 1
  })
}
