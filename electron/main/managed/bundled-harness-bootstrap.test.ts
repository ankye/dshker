import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BundledHarnessBootstrap,
  type BundledHarnessBootstrapSpawner
} from './bundled-harness-bootstrap'

/**
 * First-run preparation is the one DSH install that happens with no checkout
 * and no launch, so its step records are what keep the Console populated.
 * These tests pin the activity callback contract against a stubbed spawner.
 */

/** Builds a child that exits successfully without writing output. */
function successfulChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 4242
  })
  queueMicrotask(() => {
    child.emit('exit', 0, null)
  })
  return child
}

/**
 * Stands in for every spawned process and materializes the clone destination,
 * because the real `git clone` is what creates the staging checkout the final
 * rename moves into place.
 */
const stubSpawner: BundledHarnessBootstrapSpawner = (_executable, args) => {
  const destination = args.at(-1)
  if (args.includes('clone') && typeof destination === 'string') {
    mkdirSync(destination, { recursive: true })
  }
  return successfulChild()
}

describe('BundledHarnessBootstrap activity', () => {
  /** Builds a disposable, already-empty Harness root beside its seed bundle. */
  async function withRoot(): Promise<{
    readonly harnessDirectory: string
    readonly bundlePath: string
    readonly cleanup: () => Promise<void>
  }> {
    // macOS exposes the temporary root through `/var`, whose canonical path is
    // `/private/var`. Bootstrap deliberately rejects non-canonical inputs, so
    // the fixture must pass the same direct paths that production registration
    // provides instead of accidentally testing that operating-system alias.
    const root = await realpath(await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-bootstrap-')))
    const harnessDirectory = nodePath.join(root, 'harness')
    const bundlePath = nodePath.join(root, 'deepseek-harness.git.bundle')
    await mkdir(harnessDirectory, { recursive: true })
    await writeFile(bundlePath, 'portable DSH Git bundle fixture\n', 'utf8')
    return {
      harnessDirectory,
      bundlePath,
      cleanup: () => rm(root, { recursive: true, force: true })
    }
  }

  it('reports each preparation step in execution order', async () => {
    const { harnessDirectory, bundlePath, cleanup } = await withRoot()
    const activity: string[] = []
    try {
      const created = await new BundledHarnessBootstrap(stubSpawner).initialize({
        harnessDirectory,
        bundlePath,
        remoteUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
        gitExecutable: 'git',
        pnpmExecutable: 'pnpm',
        onActivity: (message) => {
          activity.push(message)
        }
      })

      expect(created).toBe(true)
      // The seed publishes history only; per-version directories do the building.
      expect(activity).toHaveLength(2)
      expect(activity[0]).toContain('Importing the bundled DSH Git history')
      expect(activity[1]).toContain('official DSH remote')
    } finally {
      await cleanup()
    }
  })

  it('reports nothing when the root is not empty and no work happens', async () => {
    const { harnessDirectory, bundlePath, cleanup } = await withRoot()
    const activity: string[] = []
    try {
      await writeFile(nodePath.join(harnessDirectory, 'existing.txt'), 'kept\n', 'utf8')
      const created = await new BundledHarnessBootstrap(stubSpawner).initialize({
        harnessDirectory,
        bundlePath,
        remoteUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
        gitExecutable: 'git',
        pnpmExecutable: 'pnpm',
        onActivity: (message) => {
          activity.push(message)
        }
      })

      expect(created).toBe(false)
      expect(activity).toEqual([])
    } finally {
      await cleanup()
    }
  })
})
