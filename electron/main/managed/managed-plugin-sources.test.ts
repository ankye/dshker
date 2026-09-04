import { createWriteStream } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import { ZipFile } from 'yazl'
import { ManagedPluginSources } from './managed-plugin-sources'

async function writeArchive(
  archivePath: string,
  entries: readonly Readonly<{ readonly path: string; readonly source: string }>[]
): Promise<void> {
  const archive = new ZipFile()
  for (const entry of entries) archive.addBuffer(Buffer.from(entry.source, 'utf8'), entry.path)
  archive.end()
  await pipeline(archive.outputStream, createWriteStream(archivePath, { flags: 'wx' }))
}

describe('ManagedPluginSources', () => {
  it('extracts a selected plugin ZIP under Launcher ownership before DSH sees its package root', async () => {
    const root = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-plugin-archive-'))
    )
    const archivePath = nodePath.join(root, 'dsh-test-plugin.zip')
    const pluginsDirectory = nodePath.join(root, 'plugins')
    try {
      await writeArchive(archivePath, [
        {
          path: 'dsh-test-plugin/package.json',
          source: '{"name":"dsh-test-plugin","version":"1.0.0"}\n'
        }
      ])
      const sources = new ManagedPluginSources({ pluginsDirectory, gitExecutable: 'git' })

      const materialized = await sources.materialize({ kind: 'archive', path: archivePath })

      // The managed layout uses the platform separator in real paths.
      expect(materialized.installDirectory).toMatch(/managed-sources[/\\]plugin-/u)
      await expect(
        readFile(nodePath.join(materialized.installDirectory, 'package.json'), 'utf8')
      ).resolves.toContain('dsh-test-plugin')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a ZIP that does not declare a plugin package root', async () => {
    const root = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-plugin-invalid-'))
    )
    const archivePath = nodePath.join(root, 'not-a-plugin.zip')
    const pluginsDirectory = nodePath.join(root, 'plugins')
    try {
      await writeArchive(archivePath, [{ path: 'README.md', source: 'not a plugin\n' }])
      const sources = new ManagedPluginSources({ pluginsDirectory, gitExecutable: 'git' })

      await expect(sources.materialize({ kind: 'archive', path: archivePath })).rejects.toThrow(
        'must contain one package root with package.json'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('copies a local source, records its package mapping, and removes only the managed copy', async () => {
    const root = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-plugin-source-'))
    )
    const source = nodePath.join(root, 'source')
    const pluginsDirectory = nodePath.join(root, 'plugins')
    try {
      await mkdir(source)
      await writeFile(nodePath.join(source, 'package.json'), '{"name":"dsh-test-plugin"}\n', 'utf8')
      const sources = new ManagedPluginSources({ pluginsDirectory, gitExecutable: 'git' })

      const materialized = await sources.materialize({ kind: 'local', path: source })
      expect(materialized.installDirectory).not.toBe(source)
      await expect(
        readFile(nodePath.join(materialized.installDirectory, 'package.json'), 'utf8')
      ).resolves.toContain('dsh-test-plugin')

      await sources.record('dsh-test-plugin', materialized)
      await sources.remove('dsh-test-plugin')

      await expect(access(materialized.managedDirectory)).rejects.toThrow()
      await expect(readFile(nodePath.join(source, 'package.json'), 'utf8')).resolves.toContain(
        'dsh-test-plugin'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a persisted source record that escapes the managed root', async () => {
    const root = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-plugin-record-'))
    )
    const pluginsDirectory = nodePath.join(root, 'plugins')
    try {
      const sourcesDirectory = nodePath.join(pluginsDirectory, 'managed-sources')
      await mkdir(sourcesDirectory, { recursive: true })
      await writeFile(
        nodePath.join(sourcesDirectory, 'sources.json'),
        `${JSON.stringify({
          format: 'dsh-launcher.plugin-sources',
          version: 2,
          records: [{ name: 'dsh-test-plugin', directory: root, source: { kind: 'local' } }]
        })}\n`,
        'utf8'
      )
      const sources = new ManagedPluginSources({ pluginsDirectory, gitExecutable: 'git' })

      await expect(sources.remove('dsh-test-plugin')).rejects.toThrow('source record is invalid')
      await expect(access(root)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('projects a persisted Git source revision for the installed-plugin list', async () => {
    const root = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-plugin-git-record-'))
    )
    const pluginsDirectory = nodePath.join(root, 'plugins')
    const managedDirectory = nodePath.join(pluginsDirectory, 'managed-sources', 'plugin-source')
    const revision = '0123456789abcdef0123456789abcdef01234567'
    try {
      await mkdir(managedDirectory, { recursive: true })
      await writeFile(
        nodePath.join(pluginsDirectory, 'managed-sources', 'sources.json'),
        `${JSON.stringify({
          format: 'dsh-launcher.plugin-sources',
          version: 2,
          records: [
            {
              name: 'dsh-test-plugin',
              directory: managedDirectory,
              source: {
                kind: 'git',
                cloneUrl: 'https://github.com/example/dsh-test-plugin.git',
                branch: 'main',
                packagePath: [],
                revision,
                updateAvailable: false
              }
            }
          ]
        })}\n`,
        'utf8'
      )
      const sources = new ManagedPluginSources({ pluginsDirectory, gitExecutable: 'git' })

      await expect(sources.gitSources()).resolves.toEqual(
        new Map([
          [
            'dsh-test-plugin',
            { name: 'dsh-test-plugin', revision, branch: 'main', updateAvailable: false }
          ]
        ])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
