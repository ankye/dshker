import { LAUNCHER_EXTERNAL_LINK_IDS, type LauncherExternalLinkId } from '../../src/shared/contracts'

const EXTERNAL_LINK_URLS: Readonly<Record<LauncherExternalLinkId, string>> = {
  'launcher-repository': 'https://github.com/ankye/dsh-launcher',
  'harness-repository': 'https://github.com/deepseek-ai/deepseek-harness'
}

/** Converts a Renderer selection into one fixed product-source URL. */
export function resolveExternalLink(value: unknown): string {
  if (!isLauncherExternalLinkId(value)) {
    throw new Error('External link selection is invalid.')
  }
  return EXTERNAL_LINK_URLS[value]
}

/** Checks whether a renderer value names one of the fixed product-source pages. */
function isLauncherExternalLinkId(value: unknown): value is LauncherExternalLinkId {
  return (
    typeof value === 'string' && LAUNCHER_EXTERNAL_LINK_IDS.some((candidate) => candidate === value)
  )
}
