import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  BundledSeedError,
  prepareBundledSeed,
  readBundledSeedBuildInputs,
  verifyBundledSeedDirectory
} from './bundled-seed.mjs'

const execFileAsync = promisify(execFile)
const testGitExecutable = process.env.DSH_TEST_GIT_EXECUTABLE || '/usr/bin/git'
const gitAvailable = existsSync(testGitExecutable)

describe('bundled seed', () => {
  it('requires every release input explicitly', () => {
    expect(() => readBundledSeedBuildInputs({})).toThrow(BundledSeedError)
    expect(() => readBundledSeedBuildInputs({})).toThrow(/DSH_BUNDLED_HARNESS_SOURCE/)
  })

  const runWithGit = gitAvailable ? it : it.skip
  runWithGit(
    'builds a verified bundle without source Git configuration or node_modules',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'dsh-launcher-bundled-seed-'))
      const sourceDirectory = path.join(root, 'source')
      const outputDirectory = path.join(root, 'output')
      try {
        await createDshSourceFixture(sourceDirectory)
        const remoteUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'
        const result = await prepareBundledSeed({
          sourceDirectory,
          remoteUrl,
          gitExecutable: testGitExecutable,
          outputDirectory
        })
        const verified = await verifyBundledSeedDirectory(outputDirectory)

        expect(result.manifest.harness.revision).toMatch(/^[0-9a-f]{40}$/)
        expect(verified.manifest.remoteUrl).toBe(remoteUrl)
        expect(verified.manifest.pluginGeneration.generationId).toBe(
          `bundled-${verified.manifest.harness.revision}`
        )
        expect(
          await readFile(path.join(outputDirectory, 'harness', 'deepseek-harness.git.bundle'))
        ).not.toHaveLength(0)
        expect(
          await readFile(path.join(outputDirectory, 'plugins', 'package.json'), 'utf8')
        ).toContain('dsh-web-plugin-generation')
        expect(existsSync(path.join(outputDirectory, 'harness', '.git'))).toBe(false)
        expect(existsSync(path.join(outputDirectory, 'node_modules'))).toBe(false)
        await git(root, [
          'clone',
          '--quiet',
          path.join(outputDirectory, 'harness', 'deepseek-harness.git.bundle'),
          path.join(root, 'imported')
        ])
        expect(await gitOutput(path.join(root, 'imported'), ['rev-parse', 'HEAD'])).toBe(
          verified.manifest.harness.revision
        )

        await writeFile(
          path.join(outputDirectory, 'plugins', 'package.json'),
          '{"changed":true}\n',
          'utf8'
        )
        await expect(verifyBundledSeedDirectory(outputDirectory)).rejects.toMatchObject({
          code: 'seed.resource_integrity_failed'
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

async function createDshSourceFixture(sourceDirectory) {
  const files = {
    'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-root', private: true }),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'apps/cli/package.json': JSON.stringify({
      name: '@deepseek-ai/dsh',
      dependencies: { '@deepseek-ai/dsh-web-app': 'workspace:^' }
    }),
    'apps/cli/src/bin.ts': 'export {}\n',
    'packages/bundle/base/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-base' }),
    'packages/bundle/web-app/package.json': JSON.stringify({
      name: '@deepseek-ai/dsh-web-app'
    }),
    'packages/bundle/web-app/cordis.patch.yml': '[]\n'
  }
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(sourceDirectory, relativePath)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, contents, 'utf8')
  }
  await git(sourceDirectory, ['init', '--quiet'])
  await git(sourceDirectory, ['config', 'user.email', 'seed-test@example.invalid'])
  await git(sourceDirectory, ['config', 'user.name', 'DSHKer Launcher Seed Test'])
  await git(sourceDirectory, [
    'remote',
    'add',
    'origin',
    'https://github.com/deepseek-ai/deepseek-harness.git'
  ])
  await git(sourceDirectory, ['add', '.'])
  await git(sourceDirectory, ['commit', '--quiet', '-m', 'fixture'])
}

async function git(cwd, arguments_) {
  await execFileAsync(testGitExecutable, arguments_, { cwd, windowsHide: true })
}

async function gitOutput(cwd, arguments_) {
  const result = await execFileAsync(testGitExecutable, arguments_, { cwd, windowsHide: true })
  return result.stdout.trim()
}
