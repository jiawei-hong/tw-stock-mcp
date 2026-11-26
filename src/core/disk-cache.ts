import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { taipeiToday } from './market.js'

/**
 * Opt-in disk cache for exchange answers that can no longer change: months of
 * history that have ended, and end-of-day data (institutional, margin, daily
 * quotes) for days before today in Asia/Taipei. It is off unless
 * TW_STOCK_MCP_CACHE_DIR is set, so the server stays stateless by default.
 *
 * Only requests a caller marks with a CachePolicy (cacheIfPastDay,
 * cacheIfClosedMonth) are read or written, and only complete answers are kept:
 * `stat` is "OK"/"ok", at least one row, and the top-level `date` the exchange
 * answered for matches the day or month asked for. Errors, "no data" answers
 * and answers for another day are never written. The raw response is stored, not
 * the parsed result, so parser changes apply to cached data too.
 *
 * Envelopes verified against live responses (2026-11-25, for 2026-10, 2026-11-13
 * and the Saturday 2026-11-14) on every endpoint the cache is wired into:
 * - TWSE STOCK_DAY, rwd T86, BFI82U, MI_INDEX, MI_MARGN: `stat` "OK", `date`
 *   YYYYMMDD (STOCK_DAY echoes the 1st of the month), rows in `data` or `tables[].data`.
 *   No data: `stat` "很抱歉，沒有符合條件的資料!" and no `date`.
 * - TPEx tradingStock, 3itrade_hedge_result.php, margin_bal_result.php,
 *   afterTrading/dailyQuotes: `stat` "ok", `date` YYYYMMDD (tables carry ROC dates),
 *   rows in `tables[].data`. No data: `stat` "ok" with empty `tables[0].data`.
 * - The date check matters: the older TPEx stk_quote_result.php ignored `d` and
 *   answered with the latest day (asked for 2026-11-12, got `date` 20261125).
 *   core/daily-quotes now uses dailyQuotes, which honours the date.
 *
 * Layout: <dir>/v<FORMAT_VERSION>/<2 hex>/<sha256 of URL and body>.json, each a
 * JSON envelope { version, url, body, date, saved_at, data }. A format change bumps
 * FORMAT_VERSION, so older v<N> directories are ignored (and can be deleted).
 * Files are written to a temporary name and renamed into place, so readers never
 * see a partial file; a file that does not parse or does not match is deleted and
 * the request goes to the network.
 *
 * Growth: the version directory is capped at TW_STOCK_MCP_CACHE_MAX_MB (default
 * 512 MB). When a write takes it over the cap, the least recently used files are
 * deleted until it is under 80% of the cap. For scale: one trading day of every
 * full-market dataset is about 2.8 MB (TPEx daily quotes 2 MB, MI_INDEX 250 KB,
 * T86 200 KB, TPEx institutional 145 KB, MI_MARGN 130 KB, TPEx margin 110 KB);
 * one month of one stock's history is about 3 KB.
 */

export const CACHE_DIR_ENV = 'TW_STOCK_MCP_CACHE_DIR'
export const CACHE_MAX_MB_ENV = 'TW_STOCK_MCP_CACHE_MAX_MB'

const FORMAT_VERSION = 1
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
/** After eviction the cache is at most this share of the cap, so it does not prune on every write. */
const PRUNE_TARGET = 0.8
/** Temporary files older than this are left over from a crash and are removed when pruning. */
const STALE_TEMP_MS = 60 * 60_000

/**
 * Marks a request for data that can no longer change. `date` is the trading day
 * (YYYY-MM-DD) or month (YYYY-MM) asked for; the answer must be for it.
 */
export type CachePolicy = { mode: 'immutable'; date: string }

/** A policy when `date` (YYYY-MM-DD) is before today in Asia/Taipei; undefined for today. */
export function cacheIfPastDay(date: string, now = new Date()): CachePolicy | undefined {
  return date < taipeiToday(now) ? { mode: 'immutable', date } : undefined
}

/** A policy when `month` (YYYY-MM) ended before the current month in Asia/Taipei. */
export function cacheIfClosedMonth(month: string, now = new Date()): CachePolicy | undefined {
  return month < taipeiToday(now).slice(0, 7) ? { mode: 'immutable', date: month } : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const hasRows = (value: unknown) => Array.isArray(value) && value.length > 0

/**
 * True when `data` is a complete TWSE/TPEx answer for the policy's day or month:
 * `stat` OK, a top-level `date` (YYYYMMDD) in the requested period, and rows.
 */
export function isCompleteAnswer(data: unknown, policy: CachePolicy): boolean {
  if (!isRecord(data)) return false
  if (typeof data.stat !== 'string' || data.stat.toLowerCase() !== 'ok') return false
  if (typeof data.date !== 'string' || !/^\d{8}$/.test(data.date)) return false
  if (!data.date.startsWith(policy.date.replaceAll('-', ''))) return false
  if (hasRows(data.data)) return true
  return Array.isArray(data.tables) && data.tables.some((table) => isRecord(table) && hasRows(table.data))
}

export type DiskCacheOptions = {
  dir: string
  /** Cap on the version directory, in bytes. */
  maxBytes?: number
  /** Called when the disk cannot be read or written; the request still succeeds. */
  onError?: (error: unknown) => void
}

type Entry = { file: string; size: number; usedAt: number }

export class DiskCache {
  readonly root: string
  readonly maxBytes: number
  private readonly onError: (error: unknown) => void
  /** Bytes in the version directory: unknown until the first write scans it. */
  private totalBytes: number | null = null
  private pruning: Promise<void> | null = null

  constructor(options: DiskCacheOptions) {
    this.root = join(resolve(options.dir), `v${FORMAT_VERSION}`)
    this.maxBytes = options.maxBytes !== undefined && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES
    let warned = false
    this.onError =
      options.onError ??
      ((error) => {
        if (warned) return
        warned = true
        process.emitWarning(`Disk cache at ${this.root} is not usable, continuing without it: ${String(error)}`)
      })
  }

  /** The file that holds the answer for `url` (and a request body, if any). */
  fileFor(url: string, body = ''): string {
    const hash = createHash('sha256').update(url).update('\0').update(body).digest('hex')
    return join(this.root, hash.slice(0, 2), `${hash}.json`)
  }

  /** The cached answer, or undefined on a miss. A corrupt or mismatched file is deleted. */
  async read(url: string, policy: CachePolicy, body = ''): Promise<unknown> {
    const file = this.fileFor(url, body)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error)
      return undefined
    }
    try {
      const entry: unknown = JSON.parse(text)
      if (
        isRecord(entry) &&
        entry.version === FORMAT_VERSION &&
        entry.url === url &&
        entry.body === body &&
        isCompleteAnswer(entry.data, policy)
      ) {
        // Mark it recently used, for eviction. Best effort.
        const now = new Date()
        await utimes(file, now, now).catch(() => {})
        return entry.data
      }
    } catch {
      // Not JSON: fall through and drop it.
    }
    await rm(file, { force: true }).catch(() => {})
    return undefined
  }

  /** Stores a complete answer; returns false when it is not one or the disk refused it. */
  async write(url: string, policy: CachePolicy, data: unknown, body = ''): Promise<boolean> {
    if (!isCompleteAnswer(data, policy)) return false
    const file = this.fileFor(url, body)
    const text = JSON.stringify({
      version: FORMAT_VERSION,
      url,
      body,
      date: policy.date,
      saved_at: new Date().toISOString(),
      data,
    })
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(temp, text, { flag: 'wx' })
      await rename(temp, file)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      this.onError(error)
      return false
    }
    await this.account(Buffer.byteLength(text))
    return true
  }

  private async account(bytes: number): Promise<void> {
    if (this.totalBytes === null) {
      this.totalBytes = (await this.scan()).reduce((total, entry) => total + entry.size, 0)
    } else {
      // Overwrites are counted twice; that only makes the next prune come sooner.
      this.totalBytes += bytes
    }
    if (this.totalBytes > this.maxBytes) {
      this.pruning ??= this.prune().finally(() => {
        this.pruning = null
      })
      await this.pruning
    }
  }

  /** Deletes the least recently used files until the cache is under PRUNE_TARGET of the cap. */
  private async prune(): Promise<void> {
    const entries = (await this.scan()).sort((left, right) => left.usedAt - right.usedAt)
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    const target = this.maxBytes * PRUNE_TARGET
    for (const entry of entries) {
      if (total <= target) break
      try {
        await rm(entry.file, { force: true })
        total -= entry.size
      } catch (error) {
        this.onError(error)
      }
    }
    this.totalBytes = total
  }

  /** Cache files in the version directory. Removes stale temporary files on the way. */
  private async scan(): Promise<Entry[]> {
    const entries: Entry[] = []
    let shards: string[]
    try {
      shards = await readdir(this.root)
    } catch {
      return entries
    }
    const now = Date.now()
    for (const shard of shards) {
      let names: string[]
      try {
        names = await readdir(join(this.root, shard))
      } catch {
        continue
      }
      for (const name of names) {
        const file = join(this.root, shard, name)
        try {
          const info = await stat(file)
          if (name.endsWith('.tmp')) {
            if (now - info.mtimeMs > STALE_TEMP_MS) await rm(file, { force: true })
            continue
          }
          if (name.endsWith('.json')) entries.push({ file, size: info.size, usedAt: info.mtimeMs })
        } catch {
          // Deleted by another process in the meantime.
        }
      }
    }
    return entries
  }
}

/** A cache for TW_STOCK_MCP_CACHE_DIR (and TW_STOCK_MCP_CACHE_MAX_MB), or null when it is unset. */
export function diskCacheFromEnv(env: NodeJS.ProcessEnv = process.env): DiskCache | null {
  const raw = env[CACHE_DIR_ENV]?.trim()
  if (!raw) return null
  const dir = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw
  const megabytes = Number(env[CACHE_MAX_MB_ENV])
  return new DiskCache({
    dir,
    ...(Number.isFinite(megabytes) && megabytes > 0 ? { maxBytes: megabytes * 1024 * 1024 } : {}),
  })
}

let shared: DiskCache | null | undefined

/** The process-wide disk cache, configured from the environment on first use. */
export function getDiskCache(): DiskCache | null {
  if (shared === undefined) shared = diskCacheFromEnv()
  return shared
}

/** Forgets the process-wide cache, so the next use reads the environment again (tests). */
export function resetDiskCache(): void {
  shared = undefined
}
