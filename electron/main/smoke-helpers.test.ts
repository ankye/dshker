import type { BrowserWindow } from 'electron'
import { describe, expect, it } from 'vitest'
import { smokeRoutes } from './smoke-helpers'

describe('packaged route smoke', () => {
  it('visits every current route and proves its route-owned root is mounted', async () => {
    const scripts: string[] = []
    const window = {
      webContents: {
        executeJavaScript(script: string) {
          scripts.push(script)
          return Promise.resolve(true)
        }
      }
    } as unknown as BrowserWindow

    const evidence = await smokeRoutes(window)

    expect(evidence.ok).toBe(true)
    expect(evidence.routes.map((route) => route.id)).toEqual([
      'launch',
      'controller',
      'versions',
      'usage',
      'settings',
      'runtime'
    ])
    expect(scripts).toHaveLength(6)
    expect(scripts.join('\n')).not.toContain('advanced')
    for (const selector of [
      '.launch-panel',
      '.controller-panel',
      '.version-management',
      '.usage-panel',
      '.settings-panel',
      '.browser-panel'
    ]) {
      expect(scripts.join('\n')).toContain(`document.querySelector(${JSON.stringify(selector)})`)
    }
  })
})
