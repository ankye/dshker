import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runVisualSmoke } from './visual-smoke.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('visual smoke', () => {
  it('records the source visual contract and real renderer capture command', async () => {
    const result = await runVisualSmoke(appRoot)

    expect(result.ok).toBe(true)
    expect(result.findings.some((entry) => entry.name === 'layout.stable-shell-grid')).toBe(true)
    // A run page may never fall back to a guessed loopback port.
    expect(result.findings.some((entry) => entry.name === 'runtime.no-hardcoded-url')).toBe(true)

    const evidencePath = path.join(appRoot, '.run/visual-smoke/latest.json')
    await access(evidencePath)
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    expect(evidence.rendererCaptureCommand).toBe('npm run electron:renderer-smoke')
    expect(evidence.viewportMatrix.map((entry) => entry.id)).toEqual([
      'narrow',
      'compact',
      'standard',
      'wide'
    ])
  })
})
