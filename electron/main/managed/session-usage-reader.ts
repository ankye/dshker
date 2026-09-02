import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { createZstdDecompress } from 'node:zlib'
import type {
  SessionTokenUsage,
  TokenUsageRequest,
  TokenUsageState
} from '../../../src/shared/contracts'

/** Default number of detailed session rows returned to the renderer. */
const DEFAULT_SESSION_PAGE = 50

/** Hard ceiling on detail rows, so one request cannot ask for unbounded work. */
const MAX_SESSION_PAGE = 500

/**
 * Decompresses one zstd frame and reports how many input bytes it consumed.
 *
 * `bytesWritten` is read on `close`, once the stream has fully settled, because
 * it is still being updated while data events are being emitted.
 */
function decodeFrame(input: Buffer): Promise<{ out: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createZstdDecompress()
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('close', () => {
      resolve({ out: Buffer.concat(chunks), consumed: stream.bytesWritten })
    })
    stream.on('error', reject)
    stream.end(input)
  })
}

/**
 * Decompresses a whole DSH session log.
 *
 * DSH appends each batch of events as an independent zstd frame, so a session
 * file holds thousands of frames. Node's zstd decoders stop after the first
 * frame, which would silently yield only the session header, so each frame is
 * decoded in turn from the offset the previous one consumed.
 */
export async function decompressSessionLog(
  compressed: Buffer,
  startOffset = 0
): Promise<{ text: string; consumedBytes: number }> {
  const parts: Buffer[] = []
  let offset = startOffset
  while (offset < compressed.length) {
    const { out, consumed } = await decodeFrame(compressed.subarray(offset))
    // A frame that consumes nothing would loop forever; stop at trailing bytes.
    if (consumed <= 0) break
    parts.push(out)
    offset += consumed
  }
  return { text: Buffer.concat(parts).toString('utf8'), consumedBytes: offset }
}

/** Inputs for reading DSH's own session logs; the Launcher never writes them. */
export interface SessionUsageReaderOptions {
  /** DSH_HOME, whose `sessions/` directory holds one folder per project root. */
  readonly dshHomeDirectory: string
  /**
   * Launcher-owned file holding folded per-session results.
   *
   * Sessions are append-only and a large one costs tens of milliseconds to
   * decompress, so a full re-read grows linearly with session count. The cache
   * keeps totals exact while making a repeat read proportional to what changed.
   */
  readonly cachePath: string
}

/** Persisted document identity for the folded-session cache. */
export const SESSION_USAGE_CACHE_FORMAT = 'dsh-launcher.session-usage-cache' as const

/** One cached session, keyed by the log facts that change when it grows. */
interface CachedSession {
  readonly sizeBytes: number
  readonly updatedAt: number
  /** Compressed byte offset already folded, so a grown log resumes from here. */
  readonly consumedBytes: number
  readonly folded: FoldedSession
  /** Carry-over needed to continue the replacement rule across a resume. */
  readonly last: LastReport | null
}

/** The pending replacement slot of DSH's usage fold. */
interface LastReport {
  readonly turn: number
  readonly step: number
  readonly buckets: UsageBuckets
}

/** The four disjoint billing buckets DSH's token meter records. */
interface UsageBuckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

const zeroBuckets = (): UsageBuckets => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
})

/**
 * Reads DSH's persisted session logs and reports token usage per session.
 *
 * The fold below mirrors DSH's own `tokenUsage` projection, including its
 * replacement rule, because a step reports usage twice (a streaming chunk and
 * the finalized message) and naive summing would double count it. This reader
 * is read-only: it opens session files DSH wrote and never modifies them.
 */
export class SessionUsageReader {
  readonly #options: SessionUsageReaderOptions

  constructor(options: SessionUsageReaderOptions) {
    this.#options = options
  }

  /**
   * Returns exact whole-scope totals plus the newest sessions in detail.
   *
   * Totals always cover every readable session, so the headline figures never
   * depend on how many rows the page shows. The cost of a repeat read is
   * proportional to the bytes DSH appended since the last read, not to the
   * number of sessions.
   */
  async read(request: TokenUsageRequest = {}): Promise<TokenUsageState> {
    const limit =
      request.limit !== undefined && Number.isSafeInteger(request.limit) && request.limit > 0
        ? Math.min(request.limit, MAX_SESSION_PAGE)
        : DEFAULT_SESSION_PAGE
    const files = await this.#discoverSessionFiles()
    const cache = await this.#readCache()
    const nextCache = new Map<string, CachedSession>()

    const results = await Promise.all(
      files.map(async (entry) => {
        try {
          const stats = await stat(entry.filePath)
          const cached = cache.get(entry.filePath)
          // An unchanged log is served from cache without touching zstd at all.
          if (
            cached !== undefined &&
            cached.sizeBytes === stats.size &&
            cached.updatedAt === stats.mtimeMs
          ) {
            nextCache.set(entry.filePath, cached)
            return {
              ...cached.folded,
              project: entry.project,
              updatedAt: stats.mtimeMs,
              sizeBytes: stats.size
            }
          }
          // A grown log resumes at the offset already folded; anything else
          // (truncated, rewritten, or new) is folded from the start.
          const resumable =
            cached !== undefined && stats.size > cached.sizeBytes ? cached : undefined
          const compressed = await readFile(entry.filePath)
          const { text, consumedBytes } = await decompressSessionLog(
            compressed,
            resumable?.consumedBytes ?? 0
          )
          const { folded, last } = foldSessionLog(
            text,
            resumable === undefined ? undefined : { folded: resumable.folded, last: resumable.last }
          )
          nextCache.set(entry.filePath, {
            sizeBytes: stats.size,
            updatedAt: stats.mtimeMs,
            consumedBytes,
            folded,
            last
          })
          return {
            ...folded,
            project: entry.project,
            updatedAt: stats.mtimeMs,
            sizeBytes: stats.size
          }
        } catch {
          // One corrupt or partially written log must not hide the others.
          return undefined
        }
      })
    )

    const sessions = results.filter((entry): entry is SessionTokenUsage => entry !== undefined)
    sessions.sort((left, right) => right.updatedAt - left.updatedAt)
    const totals = sessions.reduce<UsageBuckets>(
      (accumulated, session) => ({
        uncachedInputTokens: accumulated.uncachedInputTokens + session.uncachedInputTokens,
        outputTokens: accumulated.outputTokens + session.outputTokens,
        cacheReadTokens: accumulated.cacheReadTokens + session.cacheReadTokens,
        cacheWriteTokens: accumulated.cacheWriteTokens + session.cacheWriteTokens
      }),
      zeroBuckets()
    )
    await this.#writeCache(nextCache)
    return {
      kind: 'ready',
      sessions: sessions.slice(0, limit),
      totalSessions: sessions.length,
      totals,
      unreadableSessions: results.length - sessions.length
    }
  }

  /** Lists every session log under DSH_HOME, ignoring unreadable directories. */
  async #discoverSessionFiles(): Promise<
    readonly { readonly filePath: string; readonly project: string }[]
  > {
    const sessionsRoot = nodePath.join(this.#options.dshHomeDirectory, 'sessions')
    let projectDirectories: readonly string[]
    try {
      projectDirectories = (await readdir(sessionsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
    const files: { readonly filePath: string; readonly project: string }[] = []
    for (const project of projectDirectories) {
      const projectPath = nodePath.join(sessionsRoot, project)
      let sessionDirectories: readonly string[]
      try {
        sessionDirectories = (await readdir(projectPath, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        continue
      }
      for (const session of sessionDirectories) {
        files.push({
          filePath: nodePath.join(projectPath, session, 'session.jsonl.zstd'),
          project: decodeProjectDirectory(project)
        })
      }
    }
    return files
  }

  /** Loads the folded-session cache; any unusable document starts over empty. */
  async #readCache(): Promise<Map<string, CachedSession>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#options.cachePath, 'utf8'))
      if (!isRecord(parsed) || parsed.format !== SESSION_USAGE_CACHE_FORMAT) return new Map()
      const entries = parsed.sessions
      if (!isRecord(entries)) return new Map()
      const cache = new Map<string, CachedSession>()
      for (const [filePath, value] of Object.entries(entries)) {
        const admitted = admitCachedSession(value)
        if (admitted !== undefined) cache.set(filePath, admitted)
      }
      return cache
    } catch {
      return new Map()
    }
  }

  /** Persists the folded-session cache; a write failure only costs speed. */
  async #writeCache(cache: ReadonlyMap<string, CachedSession>): Promise<void> {
    try {
      const document = {
        format: SESSION_USAGE_CACHE_FORMAT,
        sessions: Object.fromEntries(cache)
      }
      await writeFile(this.#options.cachePath, `${JSON.stringify(document)}\n`, 'utf8')
    } catch {
      // The next read simply pays full cost again.
    }
  }
}

/** Admits one cached session record, rejecting any malformed shape. */
function admitCachedSession(value: unknown): CachedSession | undefined {
  if (!isRecord(value)) return undefined
  const { sizeBytes, updatedAt, consumedBytes, folded, last } = value
  if (
    typeof sizeBytes !== 'number' ||
    typeof updatedAt !== 'number' ||
    typeof consumedBytes !== 'number' ||
    !isRecord(folded) ||
    typeof folded.sessionId !== 'string' ||
    typeof folded.uncachedInputTokens !== 'number' ||
    typeof folded.outputTokens !== 'number' ||
    typeof folded.cacheReadTokens !== 'number' ||
    typeof folded.cacheWriteTokens !== 'number' ||
    typeof folded.turns !== 'number' ||
    typeof folded.steps !== 'number' ||
    typeof folded.createdAt !== 'number'
  ) {
    return undefined
  }
  return {
    sizeBytes,
    updatedAt,
    consumedBytes,
    folded: folded as unknown as FoldedSession,
    last: isRecord(last) ? (last as unknown as LastReport) : null
  }
}

/** Restores a readable project path from DSH's flattened directory name. */
export function decodeProjectDirectory(name: string): string {
  const trimmed = name.replace(/^--/u, '').replace(/--$/u, '')
  return trimmed.length === 0 ? name : `/${trimmed.split('-').join('/')}`
}

/** The per-session facts a folded log yields, before filesystem metadata. */
export type FoldedSession = Omit<SessionTokenUsage, 'project' | 'updatedAt' | 'sizeBytes'>

/**
 * Folds one decompressed session log into its billing totals and identity.
 *
 * Mirrors DSH's `tokenUsage` projection: a repeated report for the same
 * turn and step replaces the earlier value rather than adding to it, and
 * `llm/retry-started` clears that replacement slot so a retried attempt counts
 * separately. An unparsable line is skipped rather than failing the session.
 */
export function foldSessionLog(
  text: string,
  seed?: { readonly folded: FoldedSession; readonly last: LastReport | null }
): { folded: FoldedSession; last: LastReport | null } {
  const totals =
    seed === undefined
      ? zeroBuckets()
      : {
          uncachedInputTokens: seed.folded.uncachedInputTokens,
          outputTokens: seed.folded.outputTokens,
          cacheReadTokens: seed.folded.cacheReadTokens,
          cacheWriteTokens: seed.folded.cacheWriteTokens
        }
  let last: LastReport | undefined = seed?.last ?? undefined
  let sessionId = seed?.folded.sessionId ?? ''
  let createdAt = seed?.folded.createdAt ?? 0
  let model: string | undefined = seed?.folded.model
  let provider: string | undefined = seed?.folded.provider
  let firstPrompt: string | undefined = seed?.folded.firstPrompt
  let turns = seed?.folded.turns ?? 0
  let steps = seed?.folded.steps ?? 0

  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = event.type
    const data = (event.data ?? {}) as Record<string, unknown>

    if (type === 'session') {
      sessionId = typeof event.id === 'string' ? event.id : sessionId
      createdAt = typeof event.createdAt === 'number' ? event.createdAt : createdAt
      continue
    }
    if (type === 'turn/start') {
      turns += 1
      continue
    }
    if (type === 'step/start') {
      steps += 1
      continue
    }
    if (type === 'request/header' && model === undefined) {
      const config = ((data.header ?? {}) as Record<string, unknown>).config
      if (typeof config === 'object' && config !== null) {
        const record = config as Record<string, unknown>
        if (typeof record.model === 'string') model = record.model
        if (typeof record.provider === 'string') provider = record.provider
      }
      continue
    }
    if (type === 'user/message' && firstPrompt === undefined) {
      firstPrompt = firstTextContent(data.content)
      continue
    }
    if (type === 'llm/retry-started') {
      if (last !== undefined && last.turn === data.turn && last.step === data.step) {
        last = undefined
      }
      continue
    }

    const report = usageReport(type, data)
    if (report === undefined) continue
    const previous =
      last !== undefined && last.turn === report.turn && last.step === report.step
        ? last.buckets
        : undefined
    if (previous !== undefined && bucketsEqual(previous, report.buckets)) continue
    if (previous !== undefined) {
      totals.uncachedInputTokens -= previous.uncachedInputTokens
      totals.outputTokens -= previous.outputTokens
      totals.cacheReadTokens -= previous.cacheReadTokens
      totals.cacheWriteTokens -= previous.cacheWriteTokens
    }
    totals.uncachedInputTokens += report.buckets.uncachedInputTokens
    totals.outputTokens += report.buckets.outputTokens
    totals.cacheReadTokens += report.buckets.cacheReadTokens
    totals.cacheWriteTokens += report.buckets.cacheWriteTokens
    last = { turn: report.turn, step: report.step, buckets: report.buckets }
  }

  return {
    folded: {
      sessionId,
      createdAt,
      turns,
      steps,
      ...(model === undefined ? {} : { model }),
      ...(provider === undefined ? {} : { provider }),
      ...(firstPrompt === undefined ? {} : { firstPrompt }),
      ...totals
    },
    last: last ?? null
  }
}

/** Reads the usage a streaming chunk or a finalized assistant message reports. */
function usageReport(
  type: unknown,
  data: Record<string, unknown>
): { readonly turn: number; readonly step: number; readonly buckets: UsageBuckets } | undefined {
  let usage: unknown
  if (type === 'assistant/chunk') {
    const chunk = (data.chunk ?? {}) as Record<string, unknown>
    if (chunk.type !== 'usage') return undefined
    usage = chunk.usage
  } else if (type === 'assistant/message') {
    usage = data.usage
  } else {
    return undefined
  }
  if (typeof usage !== 'object' || usage === null) return undefined
  if (typeof data.turn !== 'number' || typeof data.step !== 'number') return undefined
  const record = usage as Record<string, unknown>
  return {
    turn: data.turn,
    step: data.step,
    buckets: {
      uncachedInputTokens: countOf(record.inputTokens),
      outputTokens: countOf(record.outputTokens),
      cacheReadTokens: countOf(record.cacheReadTokens),
      cacheWriteTokens: countOf(record.cacheWriteTokens)
    }
  }
}

/** Admits only a finite non-negative count; anything else contributes zero. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function bucketsEqual(left: UsageBuckets, right: UsageBuckets): boolean {
  return (
    left.uncachedInputTokens === right.uncachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens
  )
}

/** Extracts the first text block of a message, trimmed for display. */
function firstTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      const text = record.text.trim()
      if (text.length > 0) return text.slice(0, 200)
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
