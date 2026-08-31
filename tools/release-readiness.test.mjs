import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildReadinessEvidence,
  createReadinessPlan,
  redactText,
  runReadiness
} from './release-readiness-core.mjs'

const tempRoots = []

async function tempApp() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-readiness-'))
  tempRoots.push(root)
  await mkdir(path.join(root, '.git'), { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'readiness-test',
      version: '1.2.3',
      build: { appId: 'com.example.readiness', productName: 'Readiness Test' }
    })
  )
  return root
}

afterEach(async () => {
  while (tempRoots.length) {
    await rm(tempRoots.pop(), { recursive: true, force: true })
  }
})

describe('release readiness core', () => {
  it('creates the deterministic default stage order', () => {
    expect(createReadinessPlan().map((stage) => stage.id)).toEqual([
      'environment-check',
      'architecture-check',
      'format-check',
      'type-check',
      'unit-tests',
      'e2e-tests',
      'service-smoke',
      'visual-smoke',
      'performance-check',
      'package',
      'release-verify',
      'release-smoke'
    ])
  })

  it('switches package stages to template contract smoke in template mode', () => {
    expect(createReadinessPlan({ templateMode: true }).map((stage) => stage.id)).toEqual([
      'environment-check',
      'architecture-check',
      'format-check',
      'type-check',
      'unit-tests',
      'e2e-tests',
      'service-smoke',
      'visual-smoke',
      'performance-check',
      'template-package-contract'
    ])
  })

  it('uses the package release smoke command without duplicating script arguments', () => {
    const releaseSmoke = createReadinessPlan().find((stage) => stage.id === 'release-smoke')
    expect(releaseSmoke?.args.join(' ')).toContain('run release:smoke')
    expect(releaseSmoke?.args.join(' ')).not.toContain('--launch --json --launch --json')
  })

  it('redacts secrets and machine-specific absolute paths', async () => {
    const root = await tempApp()
    const raw = `${root}\\file.txt ${'to'}${'ken'}=abc12345678901234567890 ${'s'}${'k'}-test_123456789012345678901234`
    const redacted = redactText(raw, { appRoot: root })
    expect(redacted).toContain('<app-root>')
    expect(redacted).toContain(`${'to'}${'ken'}=<redacted>`)
    expect(redacted).toContain(`<${'secret'}>`)
    expect(redacted).not.toContain(root)
  })

  it('stops after a hard gate failure and writes evidence', async () => {
    const root = await tempApp()
    const evidence = await runReadiness({
      appRoot: root,
      stageTimeoutMs: 10_000,
      stages: [
        {
          id: 'pass',
          label: 'Pass',
          command: process.execPath,
          args: ['-e', 'console.log("ok")'],
          hardGate: true
        },
        {
          id: 'fail',
          label: 'Fail',
          command: process.execPath,
          args: ['-e', 'console.error("bad"); process.exit(7)'],
          hardGate: true
        },
        {
          id: 'skipped',
          label: 'Skipped',
          command: process.execPath,
          args: ['-e', 'console.log("should not run")'],
          hardGate: true
        }
      ]
    })
    const written = JSON.parse(
      await readFile(path.join(root, '.run/release-readiness/latest.json'), 'utf8')
    )
    expect(evidence.ok).toBe(false)
    expect(evidence.stages.map((stage) => stage.id)).toEqual(['pass', 'fail'])
    expect(evidence.failures[0]).toMatchObject({ stage: 'fail', exitCode: 7 })
    expect(written.failures[0].stage).toBe('fail')
  })

  it('builds the public evidence schema', async () => {
    const root = await tempApp()
    const evidence = await buildReadinessEvidence({
      appRoot: root,
      stages: [],
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      durationMs: 12,
      results: [],
      warnings: []
    })
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      ok: true,
      durationMs: 12,
      metadata: {
        appId: 'com.example.readiness',
        appVersion: '1.2.3',
        platform: process.platform
      },
      stages: [],
      failures: []
    })
  })
})
