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

async function readSources(root) {
  const files = [
    'src/app/shell/AppShell.vue',
    'src/app/shell/components/RuntimeTabsPanel.vue',
    'src/app/shell/components/SettingsPanel.vue',
    'src/app/shared/controls/ThemedListbox.vue',
    'src/styles/tokens.css',
    'src/styles/app.css',
    'src/app/shared/i18n/i18n.ts'
  ]
  return Promise.all(
    files.map(async (relativePath) => ({
      relativePath,
      source: await readFile(path.join(root, relativePath), 'utf8')
    }))
  )
}

function finding(name, ok) {
  return { name, ok, severity: 'error' }
}

function evaluateSources(sources) {
  const sourceByPath = new Map(sources.map((entry) => [entry.relativePath, entry.source]))
  const shell = sourceByPath.get('src/app/shell/AppShell.vue')
  const runtimePanel = sourceByPath.get('src/app/shell/components/RuntimeTabsPanel.vue')
  const settingsPanel = sourceByPath.get('src/app/shell/components/SettingsPanel.vue')
  const listbox = sourceByPath.get('src/app/shared/controls/ThemedListbox.vue')
  const tokens = sourceByPath.get('src/styles/tokens.css')
  const styles = sourceByPath.get('src/styles/app.css')
  const locales = sourceByPath.get('src/app/shared/i18n/i18n.ts')

  return [
    // Shell chrome: the persistent topbar, sidebar, and statusbar frame.
    finding('shell.topbar', shell.includes("t('app.title')") && styles.includes('.topbar')),
    finding('shell.sidebar-toggle', shell.includes("t('nav.collapse')")),
    finding('shell.route-navigation', shell.includes("t('versions.title')")),
    finding('shell.no-seeded-workspace', !shell.includes('templateShellData')),

    // A run page may show only the URL the started process announced.
    finding('runtime.no-hardcoded-url', !runtimePanel.includes('127.0.0.1:3080')),
    finding('runtime.announced-url-only', runtimePanel.includes('runtimeUrl')),

    // Themed controls replace native select popups that cannot be palette-styled.
    finding('controls.themed-listbox', listbox.includes('role="listbox"')),
    finding('controls.no-native-select', !settingsPanel.includes('<select')),
    finding('controls.checkbox-state', settingsPanel.includes('type="checkbox"')),

    // Theme and viewport coverage.
    finding('tokens.dark-operational-palette', tokens.includes('--color-bg: #121820')),
    finding('tokens.light-theme', tokens.includes("[data-theme='light']")),
    finding('tokens.stable-layout', tokens.includes('--layout-topbar-height')),
    finding(
      'layout.stable-shell-grid',
      styles.includes('var(--layout-topbar-height) minmax(0, 1fr)')
    ),
    finding('layout.compact-viewport', styles.includes('@media (max-width: 980px)')),
    finding('layout.narrow-viewport', styles.includes('@media (max-width: 720px)')),

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
