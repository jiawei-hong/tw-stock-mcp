/**
 * notifications/progress for one request (MCP 2025-11-25, basic/utilities/progress).
 * Updates are sent only for requests that carried `_meta.progressToken`, must
 * increase, are throttled per request, and stop once the request completes.
 */

export type ProgressToken = string | number

export type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export type Notify = (notification: JsonRpcNotification) => void

export type ProgressReporter = {
  report(progress: number, total?: number, message?: string): void
  /**
   * Ends reporting; nothing is sent afterwards. A held update is sent first when
   * `sendPending` is true (the request completed), and dropped otherwise.
   */
  close(sendPending?: boolean): void
}

/** At most one update per request in this window; the latest one is sent when it ends. */
export const PROGRESS_INTERVAL_MS = 100

const NOOP: ProgressReporter = { report: () => {}, close: () => {} }

export function progressToken(params: Record<string, unknown>): ProgressToken | undefined {
  const meta = params._meta
  if (typeof meta !== 'object' || meta === null) return undefined
  const token = (meta as Record<string, unknown>).progressToken
  return typeof token === 'string' || (typeof token === 'number' && Number.isInteger(token))
    ? token
    : undefined
}

export function createProgressReporter(
  token: ProgressToken | undefined,
  notify: Notify | undefined,
  intervalMs = PROGRESS_INTERVAL_MS
): ProgressReporter {
  if (token === undefined || !notify) return NOOP

  let closed = false
  let last = -Infinity
  let sentAt = -Infinity
  let pending: Record<string, unknown> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    timer = undefined
    if (closed || !pending) return
    const params = pending
    pending = undefined
    sentAt = Date.now()
    try {
      notify({ jsonrpc: '2.0', method: 'notifications/progress', params })
    } catch {
      // A broken transport must not fail the tool; the response path reports it.
    }
  }

  return {
    report(progress, total, message) {
      // The spec requires progress to increase with every notification.
      if (closed || !Number.isFinite(progress) || progress <= last) return
      last = progress
      pending = {
        progressToken: token,
        progress,
        ...(total !== undefined && Number.isFinite(total) ? { total } : {}),
        ...(message ? { message } : {}),
      }
      const wait = sentAt + intervalMs - Date.now()
      if (wait <= 0) flush()
      else timer ??= setTimeout(flush, wait)
    },
    close(sendPending = false) {
      if (timer) clearTimeout(timer)
      // flush() clears the timer and sends `pending` while still open.
      if (sendPending) flush()
      closed = true
      pending = undefined
      timer = undefined
    },
  }
}
