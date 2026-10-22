// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const execute = promisify(execFile)
const fixtures = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await rm(fixture, { recursive: true, force: true })
})

describe('release assembly distribution admission', () => {
  it.each(['test', undefined])(
    'refuses %s manifests before copying a published installer',
    async (distributionChannel) => {
      const parent = path.join(appRoot, '.run', 'assemble-distribution-gate')
      await mkdir(parent, { recursive: true })
      const fixture = await mkdtemp(path.join(parent, 'case-'))
      fixtures.push(fixture)
      const packageJson = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
      await writeFile(path.join(fixture, 'package.json'), JSON.stringify(packageJson))
      const inputs = path.join(fixture, 'release-input', 'macos-arm64')
      await mkdir(inputs, { recursive: true })
      await writeFile(
        path.join(inputs, 'release-manifest.json'),
        JSON.stringify({ distributionChannel })
      )
      await writeFile(path.join(inputs, 'checksums.txt'), '')
      await expect(
        execute(process.execPath, [path.join(appRoot, 'tools', 'assemble-release-assets.mjs')], {
          cwd: fixture,
          windowsHide: true,
          env: { ...process.env, GITHUB_REF_NAME: `v${packageJson.version}` }
        })
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('darwin/arm64 is not a stable distribution')
      })
      expect(await readdir(path.join(fixture, 'publish'))).toEqual([])
    }
  )
})
