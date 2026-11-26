import { createProgressReporter, type JsonRpcNotification, progressToken } from '../src/mcp/progress.js'
import { McpServer, type Tool } from '../src/mcp/server.js'

/** A slow tool that reports progress, then waits for the test to finish it. */
let finish: () => void = () => {}
let report: ((progress: number, total?: number, message?: string) => void) | undefined
const slowSteps: Tool<Record<string, never>> = {
  name: 'slow_steps',
  title: 'Slow steps',
  description: 'Reports progress in steps',
  inputSchema: { type: 'object', properties: {} },
  run: (_input, { progress }) => {
    report = progress
    progress?.(1, 4, 'month 1 of 4')
    progress?.(2, 4, 'month 2 of 4')
    progress?.(3, 4, 'month 3 of 4')
    return new Promise((resolve) => {
      finish = () => {
        progress?.(4, 4, 'month 4 of 4')
        resolve({ done: true })
      }
    })
  },
}

const call = (id: number, meta?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'slow_steps', arguments: {}, ...(meta ? { _meta: meta } : {}) },
})

const progressOf = (notifications: JsonRpcNotification[]) =>
  notifications.map((notification) => notification.params?.progress)

describe('progressToken', () => {
  it('reads string and integer tokens from _meta', () => {
    expect(progressToken({ _meta: { progressToken: 'abc' } })).toBe('abc')
    expect(progressToken({ _meta: { progressToken: 7 } })).toBe(7)
  })

  it('ignores missing and malformed tokens', () => {
    expect(progressToken({})).toBeUndefined()
    expect(progressToken({ _meta: null })).toBeUndefined()
    expect(progressToken({ _meta: { progressToken: 1.5 } })).toBeUndefined()
    expect(progressToken({ _meta: { progressToken: { id: 1 } } })).toBeUndefined()
  })
})

describe('createProgressReporter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does nothing without a token or a notify channel', () => {
    const notify = vi.fn()
    createProgressReporter(undefined, notify).report(1)
    createProgressReporter('t', undefined).report(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it('drops values that do not increase and non-finite totals', () => {
    const sent: JsonRpcNotification[] = []
    const reporter = createProgressReporter('t', (n) => sent.push(n))
    reporter.report(5, Number.NaN)
    vi.advanceTimersByTime(100)
    reporter.report(5)
    reporter.report(4)
    reporter.report(Number.NaN)
    vi.advanceTimersByTime(100)
    expect(sent).toEqual([
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 't', progress: 5 } },
    ])
  })

  it('sends a held update on close only when asked, and nothing afterwards', () => {
    const sent: JsonRpcNotification[] = []
    const completed = createProgressReporter('done', (n) => sent.push(n))
    completed.report(1)
    completed.report(2)
    completed.close(true)
    completed.report(3)
    vi.advanceTimersByTime(500)

    const cancelled = createProgressReporter('cancelled', (n) => sent.push(n))
    cancelled.report(1)
    cancelled.report(2)
    cancelled.close()
    vi.advanceTimersByTime(500)

    expect(sent.map((n) => [n.params?.progressToken, n.params?.progress])).toEqual([
      ['done', 1], ['done', 2], ['cancelled', 1],
    ])
  })

  it('keeps tool code running when the transport throws', () => {
    const reporter = createProgressReporter('t', () => {
      throw new Error('stream closed')
    })
    expect(() => reporter.report(1)).not.toThrow()
  })
})

describe('progress notifications through McpServer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const createServer = () => new McpServer({ name: 't', version: '0', tools: [slowSteps] })

  it('sends throttled updates for a request with a progress token, and none after the response', async () => {
    const sent: JsonRpcNotification[] = []
    const response = createServer().handle(call(1, { progressToken: 'p-1' }), {
      notify: (notification) => sent.push(notification),
    })
    await vi.advanceTimersByTimeAsync(0)

    // The first update goes out at once; the next two fall inside the window.
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'p-1', progress: 1, total: 4, message: 'month 1 of 4' },
      },
    ])

    // When the window ends, only the latest of the throttled updates is sent.
    await vi.advanceTimersByTimeAsync(100)
    expect(progressOf(sent)).toEqual([1, 3])

    // An update inside the next window is still held when the tool returns: it is
    // sent before the response, so the client sees the final count.
    await vi.advanceTimersByTimeAsync(50)
    let sentBeforeResponse: unknown[] = []
    finish()
    const answered = response.then((result) => {
      sentBeforeResponse = progressOf(sent)
      return result
    })
    expect(await answered).toMatchObject({ id: 1, result: { structuredContent: { done: true } } })
    expect(sentBeforeResponse).toEqual([1, 3, 4])

    // Nothing follows the response.
    await vi.advanceTimersByTimeAsync(500)
    report?.(5, 5)
    expect(progressOf(sent)).toEqual([1, 3, 4])
  })

  it('accepts integer progress tokens', async () => {
    const sent: JsonRpcNotification[] = []
    const response = createServer().handle(call(2, { progressToken: 42 }), {
      notify: (notification) => sent.push(notification),
    })
    await vi.advanceTimersByTimeAsync(0)
    finish()
    await response
    expect(sent[0]?.params?.progressToken).toBe(42)
  })

  it('stays silent when the request carried no progress token', async () => {
    const notify = vi.fn()
    const response = createServer().handle(call(3), { notify })
    await vi.advanceTimersByTimeAsync(200)
    finish()
    expect(await response).toMatchObject({ id: 3, result: { structuredContent: { done: true } } })
    expect(notify).not.toHaveBeenCalled()
  })

  it('still answers when the transport has no notify channel', async () => {
    const response = createServer().handle(call(4, { progressToken: 'p' }))
    await vi.advanceTimersByTimeAsync(0)
    finish()
    expect(await response).toMatchObject({ id: 4, result: { structuredContent: { done: true } } })
  })
})
