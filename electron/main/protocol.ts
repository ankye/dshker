import { net, protocol } from 'electron'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const LAUNCHER_HOST = 'launcher'

function response(status: number): Response {
  return new Response(null, { status })
}

function resolveStaticAsset(rendererDirectory: string, rawUrl: string): string | undefined {
  const requestUrl = new URL(rawUrl)
  if (requestUrl.protocol !== 'dsh-app:' || requestUrl.hostname !== LAUNCHER_HOST) {
    return undefined
  }

  const encodedPath = requestUrl.pathname
  if (/%2f|%5c/i.test(encodedPath)) return undefined

  const decodedPath = decodeURIComponent(encodedPath)
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.slice(1)
  if (
    !relativePath ||
    relativePath.includes('\\\\') ||
    relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return undefined
  }

  const target = path.resolve(rendererDirectory, relativePath)
  const relative = path.relative(rendererDirectory, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return target
}

async function serveLauncherAsset(rendererDirectory: string, rawUrl: string): Promise<Response> {
  const target = resolveStaticAsset(rendererDirectory, rawUrl)
  if (!target) return response(404)

  try {
    const targetStat = await stat(target)
    if (!targetStat.isFile()) return response(404)
    await access(target)
    return net.fetch(pathToFileURL(target).toString())
  } catch {
    return response(404)
  }
}

/**
 * Registers the launcher-only origin. Harness generation assets are intentionally
 * unavailable until the later manifest-bound desktop bridge implementation.
 */
export async function registerLauncherProtocol(mainDirectory: string): Promise<void> {
  const rendererDirectory = path.resolve(mainDirectory, '../renderer')
  await protocol.handle('dsh-app', (request) => serveLauncherAsset(rendererDirectory, request.url))
}
