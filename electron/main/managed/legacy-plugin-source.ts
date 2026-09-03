import nodePath from 'node:path'
import type { LauncherHarnessPluginView } from '../../../src/shared/contracts'
import { githubTreePluginUrl } from './managed-plugin-sources'
import { runText } from './process-utils'
import { ManagedHarnessRuntimeError } from './runtime-errors'

/**
 * Derives a precise managed GitHub package source from a legacy local plugin
 * checkout without mutating that checkout.
 */
export async function localGitHubPluginSource(
  gitExecutable: string,
  plugin: LauncherHarnessPluginView
): Promise<string> {
  if (plugin.localPath === undefined || plugin.sourceUrl === undefined) {
    throw new ManagedHarnessRuntimeError(
      'runtime.input_invalid',
      'This plugin has no local Git checkout that DSHKer can move under management.'
    )
  }
  let repositoryRoot: string
  let branch: string
  try {
    ;[repositoryRoot, branch] = await Promise.all([
      runText(gitExecutable, ['-C', plugin.localPath, 'rev-parse', '--show-toplevel']).then(
        (value) => value.trim()
      ),
      runText(gitExecutable, ['-C', plugin.localPath, 'branch', '--show-current']).then((value) =>
        value.trim()
      )
    ])
  } catch {
    throw new ManagedHarnessRuntimeError(
      'runtime.input_invalid',
      'This plugin local source is not a checked-out Git repository.'
    )
  }
  const relative = nodePath.relative(repositoryRoot, plugin.localPath)
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(relative)
  ) {
    throw new ManagedHarnessRuntimeError(
      'runtime.input_invalid',
      'The plugin path is outside its Git repository.'
    )
  }
  return githubTreePluginUrl(plugin.sourceUrl, branch, relative.split(nodePath.sep))
}
