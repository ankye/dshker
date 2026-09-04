import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const appShell = readFileSync(path.join(appRoot, 'src/app/shell/AppShell.vue'), 'utf8')

describe('startup update notice wiring', () => {
  it('mounts the shared update domain and gates the notice on its available-only projection', () => {
    expect(appShell).toContain('const launcherUpdates = useLauncherUpdates()')
    expect(appShell).toContain('v-if="updateNotice"')
    expect(appShell).toContain('@dismiss="launcherUpdates.dismissNotice"')
    expect(appShell).toContain('@download="launcherUpdates.openInstallerDownload"')
  })
})
