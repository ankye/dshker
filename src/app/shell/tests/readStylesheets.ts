import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Reads a stylesheet entry and expands local CSS imports in authored order. */
export function readStylesheet(filePath: string, stack = new Set<string>()): string {
  const resolved = path.resolve(filePath)
  if (stack.has(resolved)) throw new Error(`Circular stylesheet import: ${resolved}`)
  const next = new Set(stack).add(resolved)
  const source = readFileSync(resolved, 'utf8')
  return source.replace(
    /@import\s+(['"])([^'"]+)\1\s*;/gu,
    (match, _quote: string, imported: string) => {
      if (!imported.startsWith('.')) return match
      return readStylesheet(path.resolve(path.dirname(resolved), imported), next)
    }
  )
}

export function readStylesheets(root: string, names: readonly string[]): string {
  return names.map((name) => readStylesheet(path.join(root, `${name}.css`))).join('\n')
}
