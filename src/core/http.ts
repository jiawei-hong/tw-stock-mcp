import { setTimeout as delay } from 'node:timers/promises'

// Ported from tw-stock-cli src/utils/http.ts. Keep behaviour in sync.

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RETRIES = 2
const MAX_ALLOWED_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 250
const MAX_RETRY_DELAY_MS = 2_000

export type RequestJsonOptions = {
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
  signal?: AbortSignal
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
  let lastError: unknown

  for (let retry = 0; retry <= maxRetries; retry += 1) {
    options.signal?.throwIfAborted()
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal
    let responseReceived = false

    try {
      const response = await fetch(url, { signal })
      responseReceived = true
      if (!response.ok) throw new HttpStatusError(response.status)

      const data = await response.json()
      if (isRecord(data) && 'rtcode' in data && data.rtcode !== '0000') {
        throw new Error(
          `Upstream error ${String(data.rtcode)}: ${String(data.rtmessage ?? 'unknown')}`
        )
      }
      return data as T
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
      const wait = Math.min(retryDelayMs * 2 ** retry, MAX_RETRY_DELAY_MS)
      if (wait > 0) await sleep(wait)
    }
  }

  throw new Error(
    `Request failed for ${getRequestContext(url)}: ${getErrorMessage(lastError)}`
  )
}
