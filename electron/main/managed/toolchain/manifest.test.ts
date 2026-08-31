import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readCheckoutToolchainRequirements } from './manifest'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

describe('checkout toolchain manifest preflight', () => {
  it('reads only the selected worktree package.json declarations', async () => {
    const worktreePath = await createWorktree({
      engines: { node: '^22.19.0 || >=24.0.0' },
      packageManager: 'pnpm@11.7.0'
    })

    await expect(readCheckoutToolchainRequirements(worktreePath)).resolves.toMatchObject({
      worktreePath,
      packageManifestPath: nodePath.join(worktreePath, 'package.json'),
      nodeRange: { text: '^22.19.0 || >=24.0.0' },
      pnpm: { text: 'pnpm@11.7.0' }
    })
  })

  it('does not infer an absent Node or pnpm declaration', async () => {
    const missingNode = await createWorktree({ packageManager: 'pnpm@11.7.0' })
    const missingPnpm = await createWorktree({ engines: { node: '^22.19.0' } })

    await expect(readCheckoutToolchainRequirements(missingNode)).rejects.toMatchObject({
      code: 'toolchain.node_requirement_missing'
    })
    await expect(readCheckoutToolchainRequirements(missingPnpm)).rejects.toMatchObject({
      code: 'toolchain.package_manager_missing'
    })
  })

  it('rejects a malformed package manifest without inferring missing declarations', async () => {
    const malformed = await createWorktree('{')
    const undeclared = await createWorktree({})

    await expect(readCheckoutToolchainRequirements(malformed)).rejects.toMatchObject({
      code: 'toolchain.package_manifest_invalid'
    })
    await expect(readCheckoutToolchainRequirements(undeclared)).rejects.toMatchObject({
      code: 'toolchain.node_requirement_missing'
    })
  })
})

async function createWorktree(manifest: unknown): Promise<string> {
  const temporaryPath = await mkdtemp(nodePath.join(tmpdir(), 'dsh-toolchain-manifest-'))
  temporaryPaths.push(temporaryPath)
  const worktreePath = nodePath.join(temporaryPath, 'worktree')
  await mkdir(worktreePath)
  await writeFile(
    nodePath.join(worktreePath, 'package.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  )
  return realpath(worktreePath)
}
