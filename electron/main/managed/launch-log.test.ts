import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { LauncherHarnessService } from './launcher-harness-service'

/**
 * The launch log exists because the in-memory console is capped at 1000
 * fragments and is discarded when the window reloads. A startup failure that
 * scrolls past that cap was previously unrecoverable, which is exactly the case
 * a user needs when reporting "it will not start".
 *
 * These tests drive the real service against a temporary directory rather than a
 * mock, so the path it reports is the path it actually writes.
 */
describe('launch log file', () => {
  /** Builds a service whose paths are all disposable. */
  async function withService(): Promise<{
    readonly service: LauncherHarnessService
    readonly logPath: string
    readonly cleanup: () => Promise<void>
  }> {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-log-'))
    const logPath = nodePath.join(root, 'logs', 'dsh-web.log')
    const service = new LauncherHarnessService({
      harnessDirectory: nodePath.join(root, 'harness'),
      versionsDirectory: nodePath.join(root, 'versions'),
      currentVersionPointerPath: nodePath.join(root, 'harness-current.json'),
      pluginSourcesDirectory: nodePath.join(root, 'plugins'),
      dshHomeDirectory: nodePath.join(root, 'dsh-home'),
      launchPreferencesPath: nodePath.join(root, 'launch-preferences.json'),
      launchLogPath: logPath,
      diagnosticsPatchPath: nodePath.join(root, 'dsh-launcher-verbose-logging.patch.yml'),
      gitExecutable: 'git',
      pnpmExecutable: 'pnpm'
    })
    return { service, logPath, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  it('reports the log path before any launch has created the file', async () => {
    const { service, logPath, cleanup } = await withService()
    try {
      const state = await service.getState()

      // The path must be copyable while diagnosing a launch that never started,
      // so it is reported as a fact rather than omitted until the file appears.
      expect(state.logFile.path).toBe(logPath)
      expect(state.logFile.exists).toBe(false)
      expect(state.logFile.byteLength).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it('reports size once the file exists so the UI can enable its actions', async () => {
    const { service, logPath, cleanup } = await withService()
    try {
      await service.getState()
      await mkdir(nodePath.dirname(logPath), { recursive: true })
      await writeFile(logPath, 'boom\n', 'utf8')

      const state = await service.getState()
      expect(state.logFile.exists).toBe(true)
      expect(state.logFile.byteLength).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  it('refuses to reveal a log that does not exist rather than opening a stray folder', async () => {
    const { service, cleanup } = await withService()
    try {
      const showItemInFolder = vi.fn()
      await expect(service.revealLog(showItemInFolder)).rejects.toThrow()
      expect(showItemInFolder).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  it('reveals the service-owned path, which the renderer cannot influence', async () => {
    const { service, logPath, cleanup } = await withService()
    try {
      await mkdir(nodePath.dirname(logPath), { recursive: true })
      await writeFile(logPath, 'output\n', 'utf8')
      const showItemInFolder = vi.fn()

      await service.revealLog(showItemInFolder)

      expect(showItemInFolder).toHaveBeenCalledWith(logPath)
    } finally {
      await cleanup()
    }
  })

  it('exports a byte-identical copy to the chosen destination', async () => {
    const { service, logPath, cleanup } = await withService()
    try {
      await mkdir(nodePath.dirname(logPath), { recursive: true })
      const contents = '[launcher] starting dsh web\nEADDRINUSE: port 3080\n'
      await writeFile(logPath, contents, 'utf8')
      const destination = nodePath.join(nodePath.dirname(logPath), 'exported.log')

      await service.exportLog(destination)

      expect(await readFile(destination, 'utf8')).toBe(contents)
      expect((await stat(destination)).size).toBe((await stat(logPath)).size)
    } finally {
      await cleanup()
    }
  })

  it('refuses to export a log that does not exist', async () => {
    const { service, logPath, cleanup } = await withService()
    try {
      await expect(
        service.exportLog(nodePath.join(nodePath.dirname(logPath), 'exported.log'))
      ).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })
})
