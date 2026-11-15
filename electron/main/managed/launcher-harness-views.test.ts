import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readHarnessReadiness } from './launcher-harness-views'

const created: string[] = []

/** A checkout root that passes the direct-directory fence on every platform. */
async function checkoutRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(nodePath.join(tmpdir(), 'dshker-readiness-')))
  created.push(root)
  return root
}

/** One checkout with the manifest, the built entry, and the Git worktree pointer. */
async function writeCheckout(
  root: string,
  options: { builtEntry?: string; dependencies?: readonly string[] } = {}
): Promise<void> {
  const builtEntry = options.builtEntry ?? "import '@deepseek-ai/dsh-app-boot'\n"
  await writeFile(nodePath.join(root, '.git'), 'gitdir: test\n', 'utf8')
  await writeFile(
    nodePath.join(root, 'package.json'),
    JSON.stringify({ name: 'harness', version: '1.0.0' }),
    'utf8'
  )
  await mkdir(nodePath.join(root, 'apps', 'cli', 'lib'), { recursive: true })
  await writeFile(nodePath.join(root, 'apps', 'cli', 'lib', 'bin.js'), builtEntry, 'utf8')
  for (const dependency of options.dependencies ?? [
    'node_modules/tsx/package.json',
    'apps/cli/node_modules/@deepseek-ai/dsh-app-boot/package.json'
  ]) {
    const path = nodePath.join(root, dependency)
    await mkdir(nodePath.dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ name: dependency }), 'utf8')
  }
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('readHarnessReadiness', () => {
  it('reports ready when the built entry and its resolved dependencies are present', async () => {
    const root = await checkoutRoot()
    await writeCheckout(root)
    await expect(readHarnessReadiness(root)).resolves.toEqual({ kind: 'ready' })
  })

  it('reports missing for an absent checkout', async () => {
    const root = nodePath.join(await checkoutRoot(), 'absent')
    await expect(readHarnessReadiness(root)).resolves.toMatchObject({ kind: 'missing' })
  })

  it('reports the missing built checkout when the CLI entry is not built', async () => {
    const root = await checkoutRoot()
    await writeCheckout(root)
    await rm(nodePath.join(root, 'apps', 'cli', 'lib', 'bin.js'))
    await expect(readHarnessReadiness(root)).resolves.toMatchObject({
      kind: 'invalid',
      message: 'The Launcher Harness directory is missing its built DSH checkout.'
    })
  })

  it('reports an unresolvable dependency tree when the source launcher runtime is absent', async () => {
    const root = await checkoutRoot()
    await writeCheckout(root, {
      dependencies: ['apps/cli/node_modules/@deepseek-ai/dsh-app-boot/package.json']
    })
    await expect(readHarnessReadiness(root)).resolves.toMatchObject({
      kind: 'invalid',
      message: 'The Launcher Harness directory has an unresolvable dependency tree.'
    })
  })

  it('reports an unresolvable dependency tree when an entry dependency link dangles', async () => {
    const root = await checkoutRoot()
    await writeCheckout(root, { dependencies: ['node_modules/tsx/package.json'] })
    const link = nodePath.join(root, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'dsh-app-boot')
    await mkdir(nodePath.dirname(link), { recursive: true })
    // A pnpm link whose target is gone: the entry point exists, the install does not.
    await symlink(nodePath.join(root, 'packages', 'boot', 'app-boot'), link, 'junction')
    await expect(readHarnessReadiness(root)).resolves.toMatchObject({
      kind: 'invalid',
      message: 'The Launcher Harness directory has an unresolvable dependency tree.'
    })
  })

  it('accepts a built entry that imports no Harness package', async () => {
    const root = await checkoutRoot()
    await writeCheckout(root, {
      builtEntry: 'process.stdout.write("built")\n',
      dependencies: ['node_modules/tsx/package.json']
    })
    await expect(readHarnessReadiness(root)).resolves.toEqual({ kind: 'ready' })
  })
})
