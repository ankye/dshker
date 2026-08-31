import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { lstat, mkdtemp, readdir, readFile, realpath, rename, rmdir } from 'node:fs/promises'
import nodePath from 'node:path'
import { tmpdir } from 'node:os'
import { load as loadYaml } from 'js-yaml'
import type { PluginCatalogEntry, PluginCatalogState } from '../../../src/shared/contracts'

const AWESOME_DSH_PLUGIN_REMOTE = 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.git'
const AWESOME_DSH_PLUGIN_BRANCH = 'main'
const CATALOG_DIRECTORY_NAME = 'awesome-dsh-plugin'

/** The launcher-managed source inputs for the curated DSH plugin directory. */
export interface AwesomePluginCatalogOptions {
  readonly pluginsDirectory: string
  readonly gitExecutable: string
}

/** Synchronizes and parses the source repository selected by the product. */
export class AwesomePluginCatalog {
  readonly #options: AwesomePluginCatalogOptions

  constructor(options: AwesomePluginCatalogOptions) {
    this.#options = options
  }

  /** Returns the last synchronized source only; it never reaches the network. */
  async getState(): Promise<PluginCatalogState> {
    const directory = this.#catalogDirectory()
    try {
      await assertDirectDirectory(directory)
    } catch (error) {
      if (isMissing(error)) {
        return {
          kind: 'empty',
          remoteUrl: AWESOME_DSH_PLUGIN_REMOTE,
          entries: []
        }
      }
      throw new Error('The downloaded plugin catalog directory is invalid.')
    }
    await assertDirectDirectory(nodePath.join(directory, '.git'))
    const [revision, entries] = await Promise.all([
      runText(this.#options.gitExecutable, ['-C', directory, 'rev-parse', 'HEAD']).then((value) =>
        value.trim()
      ),
      this.#readEntries(directory)
    ])
    return {
      kind: 'ready',
      remoteUrl: AWESOME_DSH_PLUGIN_REMOTE,
      revision,
      entries
    }
  }

  /** Clones or fast-forwards the Launcher-owned catalog source, then parses every entry file. */
  async refresh(): Promise<PluginCatalogState> {
    await assertDirectDirectory(this.#options.pluginsDirectory)
    const directory = this.#catalogDirectory()
    try {
      await assertDirectDirectory(directory)
      await assertDirectDirectory(nodePath.join(directory, '.git'))
      await runText(this.#options.gitExecutable, ['-C', directory, 'fetch', '--prune', 'origin'])
      await runText(this.#options.gitExecutable, [
        '-C',
        directory,
        'checkout',
        '--detach',
        `origin/${AWESOME_DSH_PLUGIN_BRANCH}`
      ])
    } catch (error) {
      if (!isMissing(error)) throw error
      await this.#clone(directory)
    }
    return this.getState()
  }

  #catalogDirectory(): string {
    return nodePath.join(this.#options.pluginsDirectory, CATALOG_DIRECTORY_NAME)
  }

  async #clone(directory: string): Promise<void> {
    const staging = await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-awesome-plugin-'))
    const checkout = nodePath.join(staging, CATALOG_DIRECTORY_NAME)
    try {
      await runText(this.#options.gitExecutable, [
        'clone',
        '--branch',
        AWESOME_DSH_PLUGIN_BRANCH,
        '--single-branch',
        AWESOME_DSH_PLUGIN_REMOTE,
        checkout
      ])
      await rename(checkout, directory)
    } finally {
      await rmdir(staging).catch(() => undefined)
    }
  }

  async #readEntries(directory: string): Promise<readonly PluginCatalogEntry[]> {
    const dataDirectory = nodePath.join(directory, 'data', 'plugins')
    await assertDirectDirectory(dataDirectory)
    const fileNames = (await readdir(dataDirectory)).filter((name) => name.endsWith('.yml')).sort()
    return Promise.all(
      fileNames.map(async (fileName) => {
        const filePath = nodePath.join(dataDirectory, fileName)
        await assertDirectRegularFile(filePath)
        return parsePluginCatalogEntry(await readFile(filePath, 'utf8'), fileName)
      })
    )
  }
}

/** Parses one source-owned awesome-dsh-plugin YAML record into a renderer-safe catalog entry. */
export function parsePluginCatalogEntry(source: string, fileName: string): PluginCatalogEntry {
  const parsed: unknown = loadYaml(source)
  if (!isRecord(parsed)) throw new Error(`Plugin catalog entry ${fileName} is invalid.`)
  const { url, name, category, description } = parsed
  if (
    typeof url !== 'string' ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+/u.test(url) ||
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    typeof category !== 'string' ||
    category.trim().length === 0 ||
    !isRecord(description) ||
    typeof description.en !== 'string' ||
    description.en.trim().length === 0 ||
    (description.zh !== undefined && typeof description.zh !== 'string')
  ) {
    throw new Error(`Plugin catalog entry ${fileName} is invalid.`)
  }
  return {
    id: fileName.slice(0, -'.yml'.length),
    url,
    name,
    category,
    description: typeof description.zh === 'string' ? description.zh : description.en
  }
}

async function assertDirectDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error('A direct directory is required.')
  }
}

async function assertDirectRegularFile(filePath: string): Promise<void> {
  const metadata = await lstat(filePath)
  if (metadata.isSymbolicLink() || !metadata.isFile() || (await realpath(filePath)) !== filePath) {
    throw new Error('A direct regular file is required.')
  }
}

function runText(
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(executable, arguments_, {
        ...options,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: unknown) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.slice(-4096)))
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
