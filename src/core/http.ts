import { setTimeout as delay } from 'node:timers/promises'

import { type CachePolicy, getDiskCache } from './disk-cache.js'

// Ported from tw-stock-cli src/utils/http.ts. Timeouts, retries, backoff and error
// messages still match it and should stay in sync. Diverges in two places:
// - every attempt queues on a per-host limiter (HostLimiter below), and
// - `cache` lets the opt-in disk cache (disk-cache.ts) answer immutable past data.

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RETRIES = 2
const MAX_ALLOWED_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 250
const MAX_RETRY_DELAY_MS = 2_000

/**
 * Per-host limits. Neither exchange publishes a rate limit, so these aim to look
 * like one careful browser tab when an agent fires several tools in parallel:
 * - 2 requests in flight per host, the old RFC 2616 (8.1.4) per-server connection
 *   guidance. It lets a quick lookup run beside a slow full-market download
 *   (MI_INDEX, T86 and friends take up to 30 s) instead of queueing behind it.
 * - 200 ms between request starts per host, so a burst is at most 5 starts a
 *   second. Sequential loaders are barely affected: history.ts already waits
 *   250 ms after each monthly response, and a tool call makes 1-4 requests.
 */
const MAX_CONCURRENT_PER_HOST = 2
const MIN_START_GAP_MS = 200

export type HostLimiterOptions = {
  /** Requests in flight at once to one host. */
  maxConcurrent?: number
  /** Minimum time between the starts of two requests to one host, in ms. */
  minGapMs?: number
  /** Monotonic clock in ms. Defaults to performance.now(), which fake Date timers leave alone. */
  now?: () => number
  /** Waits `delayMs`; should reject when `signal` aborts. */
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}

type HostQueue = { active: number; nextStartAt: number; waiting: (() => void)[] }

/** One FIFO queue per hostname, with a concurrency cap and a minimum gap between starts. */
export class HostLimiter {
  readonly maxConcurrent: number
  readonly minGapMs: number
  private readonly now: () => number
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>
  private readonly hosts = new Map<string, HostQueue>()

  constructor(options: HostLimiterOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? MAX_CONCURRENT_PER_HOST))
    this.minGapMs = Math.max(0, options.minGapMs ?? MIN_START_GAP_MS)
    this.now = options.now ?? (() => performance.now())
    this.sleep = options.sleep ?? ((delayMs, signal) => delay(delayMs, undefined, { signal }))
  }

  /**
   * Resolves once `host` has a free slot and the gap since the previous start has
   * passed, with a function that frees the slot. If `signal` aborts first, the
   * request leaves the queue and this rejects with `signal.reason`.
   */
  async acquire(host: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    const queue = this.queueFor(host)
    if (queue.active < this.maxConcurrent && !queue.waiting.length) queue.active += 1
    else await this.waitForSlot(queue, signal)

    let released = false
    const release = () => {
      if (released) return
      released = true
      const next = queue.waiting.shift()
      // Hand the slot straight to the next waiter, or give it back.
      if (next) next()
      else queue.active -= 1
    }
    try {
      const now = this.now()
      const startAt = Math.max(now, queue.nextStartAt)
      queue.nextStartAt = startAt + this.minGapMs
      if (startAt > now) await this.sleep(startAt - now, signal)
      signal?.throwIfAborted()
    } catch (error) {
      release()
      if (signal?.aborted) throw signal.reason
      throw error
    }
    return release
  }

  /** Requests holding a slot on `host`, and requests waiting for one. */
  load(host: string): { active: number; waiting: number } {
    const queue = this.hosts.get(host)
    return { active: queue?.active ?? 0, waiting: queue?.waiting.length ?? 0 }
  }

  private queueFor(host: string): HostQueue {
    let queue = this.hosts.get(host)
    if (!queue) {
      queue = { active: 0, nextStartAt: Number.NEGATIVE_INFINITY, waiting: [] }
      this.hosts.set(host, queue)
    }
    return queue
  }

  private waitForSlot(queue: HostQueue, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = queue.waiting.indexOf(grant)
        if (index !== -1) queue.waiting.splice(index, 1)
        reject(signal?.reason)
      }
      const grant = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      queue.waiting.push(grant)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

let sharedLimiter = new HostLimiter()

/** Replaces the process-wide limiter (tests: tests/setup.ts drops the gap for stubbed fetch). */
export function configureHostLimiter(options: HostLimiterOptions = {}): void {
  sharedLimiter = new HostLimiter(options)
}

export type RequestJsonOptions = {
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
  signal?: AbortSignal
  /**
   * Marks data that can no longer change (see cacheIfPastDay / cacheIfClosedMonth
   * in disk-cache.ts), so the opt-in disk cache may answer and keep it.
   */
  cache?: CachePolicy
  /** The limiter to queue on. Defaults to the process-wide one; tests inject their own. */
  limiter?: HostLimiter
  /**
   * Called once when the answer has to come from the exchange, not the disk cache.
   * Multi-request loops use it to pace real requests only (see RequestPacer).
   */
  onNetwork?: () => void
}

/**
 * Pacing for a sequential multi-request loop: wait `gapMs` before a step only
 * when the step before it went to the network. Steps answered from the memory
 * or disk cache cost no wait. Pass `onNetwork` to every request of a step.
 */
export class RequestPacer {
  private wentOut = false

  constructor(
    private readonly gapMs: number,
    private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<unknown> = (delayMs, signal) =>
      delay(delayMs, undefined, { signal })
  ) {}

  readonly onNetwork = (): void => {
    this.wentOut = true
  }

  /** Call before each step. */
  async beforeStep(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.wentOut) await this.sleep(this.gapMs, signal)
    this.wentOut = false
  }
}

export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpStatusError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getRequestContext(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}`
  } catch {
    return url
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function isTimeoutError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  if (!isRecord(error) || typeof error.name !== 'string') return false
  return error.name === 'AbortError' || error.name === 'TimeoutError'
}

function shouldRetry(
  error: unknown,
  signal: AbortSignal,
  responseReceived: boolean
): boolean {
  if (error instanceof HttpStatusError) {
    return error.status === 429 || error.status >= 500
  }
  if (isTimeoutError(error, signal)) return true
  return !responseReceived
}

function clamp(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export async function requestJson<T>(
  url: string,
  options: RequestJsonOptions = {}
): Promise<T> {
  const disk = options.cache ? getDiskCache() : null
  if (disk && options.cache) {
    const hit = await disk.read(url, options.cache)
    if (hit !== undefined) return hit as T
  }
  options.onNetwork?.()
  const data = await fetchWithRetries(url, options)
  // The cache keeps only complete answers for the requested period; see disk-cache.ts.
  if (disk && options.cache) await disk.write(url, options.cache, data)
  return data as T
}

async function fetchWithRetries(url: string, options: RequestJsonOptions): Promise<unknown> {
  const maxRetries = Math.floor(
    clamp(options.maxRetries, DEFAULT_MAX_RETRIES, 0, MAX_ALLOWED_RETRIES)
  )
  const timeoutMs =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS
  const retryDelayMs = clamp(
    options.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS,
    0,
    MAX_RETRY_DELAY_MS
  )
  const sleep =
    options.sleep ??
    ((delayMs: number) => delay(delayMs, undefined, { signal: options.signal }))
  const limiter = options.limiter ?? sharedLimiter
  const host = hostOf(url)
  let lastError: unknown

  for (let retry = 0; retry <= maxRetries; retry += 1) {
    options.signal?.throwIfAborted()
    // One slot per attempt, freed before the backoff, so a retry never holds a
    // slot while it waits for another and parallel retries cannot deadlock.
    const release = await limiter.acquire(host, options.signal)
    // The timeout starts once the request is sent, not while it queues.
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal
    let responseReceived = false
    let wait = 0

    try {
      const response = await fetch(url, { signal })
      responseReceived = true
      if (!response.ok) throw new HttpStatusError(response.status)

      const data: unknown = await response.json()
      if (isRecord(data) && 'rtcode' in data && data.rtcode !== '0000') {
        throw new Error(
          `Upstream error ${String(data.rtcode)}: ${String(data.rtmessage ?? 'unknown')}`
        )
      }
      return data
    } catch (error) {
      options.signal?.throwIfAborted()
      lastError = error
      if (retry === maxRetries || !shouldRetry(error, signal, responseReceived)) {
        throw new Error(
          `Request failed for ${getRequestContext(url)} after ${retry + 1} attempt${
            retry === 0 ? '' : 's'
          }: ${getErrorMessage(error)}`,
          { cause: error }
        )
      }
      wait = Math.min(retryDelayMs * 2 ** retry, MAX_RETRY_DELAY_MS)
    } finally {
      release()
    }
    if (wait > 0) await sleep(wait)
  }

  throw new Error(
    `Request failed for ${getRequestContext(url)}: ${getErrorMessage(lastError)}`
  )
}
