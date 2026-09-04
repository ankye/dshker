import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  describePluginInstallSource,
  formatLauncherOperationFailure,
  formatLauncherStepCompletion,
  formatLauncherStepHeartbeat,
  LauncherHarnessService,
  type LauncherHarnessServiceOptions
} from './launcher-harness-service'

/**
 * The console is the one surface that must never go blank while the Launcher
 * works: first-run preparation, updates, switches, and plugin operations all
 * record their steps here even when no DSH Web child ever starts. These tests
 * pin that recording, the push channel that carries it to the renderer, and
 * the durable file that survives a force-quit during a stalled operation.
 */
describe('launcher console activity', () => {
  /** Builds a service whose paths are all disposable. */
  async function withService(): Promise<{
    readonly service: LauncherHarnessService
    readonly logPath: string
    readonly cleanup: () => Promise<void>
  }> {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-console-'))
    const logPath = nodePath.join(root, 'logs', 'dsh-web.log')
    const options: LauncherHarnessServiceOptions = {
      harnessDirectory: nodePath.join(root, 'harness'),
      versionsDirectory: nodePath.join(root, 'versions'),
      currentVersionPointerPath: nodePath.join(root, 'harness-current.json'),
      pluginSourcesDirectory: nodePath.join(root, 'plugins'),
      dshHomeDirectory: nodePath.join(root, 'dsh-home'),
      launchPreferencesPath: nodePath.join(root, 'launch-preferences.json'),
      launchLogPath: logPath,
      diagnosticsPatchPath: nodePath.join(root, 'verbose.patch.yml'),
      gitExecutable: 'git',
      pnpmExecutable: 'pnpm'
    }
    return {
      service: new LauncherHarnessService(options),
      logPath,
      cleanup: () => rm(root, { recursive: true, force: true })
    }
  }

  it('keeps externally recorded activity in the state console while the checkout is missing', async () => {
    const { service, cleanup } = await withService()
    try {
      service.recordOperationActivity(
        'Installing DSH dependencies (pnpm install --frozen-lockfile).'
      )

      const state = await service.getState()

      // The checkout is missing here on purpose: activity must be observable
      // exactly when there is no started DSH Web to show instead.
      expect(state.kind).toBe('missing')
      expect(state.console).toHaveLength(1)
      expect(state.console[0]?.stream).toBe('launcher')
      expect(state.console[0]?.text).toContain('pnpm install --frozen-lockfile')
      expect(state.console[0]?.seq).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('pushes every appended entry to its subscriber with an increasing sequence', async () => {
    const { service, cleanup } = await withService()
    try {
      const received: number[] = []
      const unsubscribe = service.onConsoleAppend((entry) => received.push(entry.seq))

      service.recordOperationActivity('step one')
      service.recordOperationActivity('step two')

      expect(received).toEqual([1, 2])
      unsubscribe()
      service.recordOperationActivity('step three')
      expect(received).toEqual([1, 2])
    } finally {
      await cleanup()
    }
  })

  it('records bundled-seed preparation transitions as console events', async () => {
    const { service, cleanup } = await withService()
    try {
      const events: string[] = []
      service.onConsoleAppend((entry) => events.push(entry.text))

      service.setBootstrapState('preparing')
      service.setBootstrapState(undefined)
      service.setBootstrapState({ kind: 'failed', message: 'bundle unavailable' })

      expect(events[0]).toContain('Preparing the bundled DSH')
      expect(events[1]).toContain('Bundled DSH preparation completed')
      expect(events[2]).toContain('Bundled DSH preparation failed: bundle unavailable')

      // The failed preparation state stays observable through getState.
      const state = await service.getState()
      expect(state.kind).toBe('invalid')
      expect(state.console).toHaveLength(3)
    } finally {
      await cleanup()
    }
  })

  it('formats operation failures with the failing reason, never a bare rejection', () => {
    expect(formatLauncherOperationFailure('Updating DSH', new Error('fetch declined'))).toBe(
      'Updating DSH failed: fetch declined'
    )
    expect(formatLauncherOperationFailure('Updating DSH', 'fetch declined')).toBe(
      'Updating DSH failed: unknown error'
    )
  })

  it('names each plugin install source kind in console records', () => {
    expect(describePluginInstallSource({ kind: 'git', url: 'https://example.test/a.git' })).toBe(
      'plugin from https://example.test/a.git'
    )
    expect(describePluginInstallSource({ kind: 'local', path: '/plugins/a' })).toBe(
      'plugin from local directory /plugins/a'
    )
    expect(describePluginInstallSource({ kind: 'archive', path: '/tmp/a.zip' })).toBe(
      'plugin archive /tmp/a.zip'
    )
  })

  it('notifies no listeners after every subscriber unsubscribes', async () => {
    const { service, cleanup } = await withService()
    try {
      const listener = vi.fn()
      const unsubscribe = service.onConsoleAppend(listener)
      unsubscribe()
      unsubscribe()

      service.recordOperationActivity('isolated step')

      expect(listener).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  it('appends a rejected operation start and failure to the durable log file', async () => {
    const { service, logPath, cleanup } = await withService()
    try {
      // An invalid name fails after the operation wrapper starts recording;
      // the harness directory is missing, so readiness fails first either way.
      await expect(service.uninstallPlugin('dsh-example-plugin')).rejects.toThrow()
      // The append stream flushes asynchronously after the operation ends.
      await new Promise((resolve) => {
        setTimeout(resolve, 200)
      })

      const log = await readFile(logPath, 'utf8')
      // The file is the only witness after a force-quit, so both the attempt
      // and its reason must be there — not only in the in-memory console.
      expect(log).toContain('Removing plugin dsh-example-plugin…')
      expect(log).toContain('Removing plugin dsh-example-plugin failed:')
    } finally {
      await cleanup()
    }
  })

  it('formats step completions with whole elapsed seconds', () => {
    expect(formatLauncherStepCompletion('Removing untracked build residue', 90_000)).toBe(
      'Removing untracked build residue finished in 90s.'
    )
    expect(formatLauncherStepCompletion('Verifying the selected commit', 400)).toBe(
      'Verifying the selected commit finished in 0s.'
    )
  })

  it('formats silent-step heartbeats that re-assert elapsed progress', () => {
    expect(formatLauncherStepHeartbeat('Removing untracked build residue', 300_000)).toBe(
      'Removing untracked build residue still running (300s elapsed)…'
    )
  })
})
