import { HostLimiter, RequestPacer, requestJson } from '../src/core/http.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** A limiter on a virtual clock: sleeping advances the clock instead of waiting. */
function virtualLimiter(options: { maxConcurrent?: number; minGapMs?: number } = {}) {
  const state = { clock: 0, sleeps: [] as number[] }
  const limiter = new HostLimiter({
    ...options,
    now: () => state.clock,
    sleep: async (delayMs, signal) => {
      state.sleeps.push(delayMs)
      signal?.throwIfAborted()
      state.clock += delayMs
    },
  })
  return { limiter, state }
}

/** A sleep that only ends when its signal aborts. */
const sleepUntilAborted = (_delayMs: number, signal?: AbortSignal) =>
  new Promise<void>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

describe('HostLimiter', () => {
  it('caps requests in flight per host and hands slots over in arrival order', async () => {
    const { limiter } = virtualLimiter({ maxConcurrent: 2, minGapMs: 0 })
    const granted: string[] = []
    const releases = new Map<string, () => void>()
    for (const name of ['a', 'b', 'c', 'd']) {
      void limiter.acquire('www.twse.com.tw').then((release) => {
        granted.push(name)
        releases.set(name, release)
      })
    }
    await settle()
    expect(granted).toEqual(['a', 'b'])
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 2, waiting: 2 })

    releases.get('b')?.()
    await settle()
    expect(granted).toEqual(['a', 'b', 'c'])
    releases.get('a')?.()
    await settle()
    expect(granted).toEqual(['a', 'b', 'c', 'd'])

    releases.get('c')?.()
    releases.get('d')?.()
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 0, waiting: 0 })
  })

  it('keeps each host in its own queue', async () => {
    const { limiter } = virtualLimiter({ maxConcurrent: 1, minGapMs: 200 })
    await limiter.acquire('www.twse.com.tw')
    const other = await limiter.acquire('www.tpex.org.tw')
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 1, waiting: 0 })
    expect(limiter.load('www.tpex.org.tw')).toEqual({ active: 1, waiting: 0 })
    other()
  })

  it('spaces request starts to one host by the minimum gap', async () => {
    const { limiter, state } = virtualLimiter({ maxConcurrent: 2, minGapMs: 200 })
    const starts: number[] = []
    for (let index = 0; index < 3; index += 1) {
      const release = await limiter.acquire('www.twse.com.tw')
      starts.push(state.clock)
      release()
    }
    expect(starts).toEqual([0, 200, 400])

    // Two at once: the second waits for the gap even though a slot is free.
    const [first, second] = await Promise.all([
      limiter.acquire('www.tpex.org.tw'),
      limiter.acquire('www.tpex.org.tw'),
    ])
    expect(state.sleeps).toEqual([200, 200, 200])
    first()
    second()
  })

  it('does not wait when the gap has already passed', async () => {
    const { limiter, state } = virtualLimiter({ maxConcurrent: 2, minGapMs: 200 })
    ;(await limiter.acquire('www.twse.com.tw'))()
    state.clock += 500
    ;(await limiter.acquire('www.twse.com.tw'))()
    expect(state.sleeps).toEqual([])
  })

  it('drops a request aborted while it queues and serves the one behind it', async () => {
    const { limiter } = virtualLimiter({ maxConcurrent: 1, minGapMs: 0 })
    const release = await limiter.acquire('www.twse.com.tw')
    const controller = new AbortController()
    const aborted = limiter.acquire('www.twse.com.tw', controller.signal)
    const next = limiter.acquire('www.twse.com.tw')
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 1, waiting: 2 })

    const reason = new Error('cancelled by client')
    controller.abort(reason)
    await expect(aborted).rejects.toBe(reason)
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 1, waiting: 1 })

    release()
    const releaseNext = await next
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 1, waiting: 0 })
    releaseNext()
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 0, waiting: 0 })
  })

  it('frees the slot when a request is aborted during the spacing wait', async () => {
    const limiter = new HostLimiter({ maxConcurrent: 2, minGapMs: 200, now: () => 0, sleep: sleepUntilAborted })
    const first = await limiter.acquire('www.twse.com.tw')
    const controller = new AbortController()
    const spaced = limiter.acquire('www.twse.com.tw', controller.signal)
    await settle()
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 2, waiting: 0 })

    controller.abort(new Error('cancelled'))
    await expect(spaced).rejects.toThrow('cancelled')
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 1, waiting: 0 })
    first()
  })

  it('rejects at once when the signal has already aborted', async () => {
    const { limiter } = virtualLimiter()
    const reason = new Error('gone')
    await expect(limiter.acquire('www.twse.com.tw', AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 0, waiting: 0 })
  })

  it('ignores a second release of the same slot', async () => {
    const { limiter } = virtualLimiter({ maxConcurrent: 1, minGapMs: 0 })
    const release = await limiter.acquire('www.twse.com.tw')
    const other = await limiter.acquire('www.tpex.org.tw')
    release()
    release()
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 0, waiting: 0 })
    other()
  })
})

describe('requestJson with the per-host limiter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** fetch that waits for the test to answer each request, and honours the signal it is given. */
  function stubPendingFetch() {
    const pending: { url: string; answer: (body: unknown, status?: number) => void }[] = []
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      const response = deferred<Response>()
      pending.push({
        url: String(input),
        answer: (body, status = 200) => response.resolve(new Response(JSON.stringify(body), { status })),
      })
      return response.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    return { pending, fetchMock }
  }

  it('sends every request through its host queue', async () => {
    const { pending } = stubPendingFetch()
    const limiter = new HostLimiter({ maxConcurrent: 2, minGapMs: 0 })
    const twse = ['A', 'B', 'C'].map((id) => requestJson(`https://www.twse.com.tw/x?id=${id}`, { limiter }))
    const tpex = requestJson('https://www.tpex.org.tw/y', { limiter })
    await settle()
    expect(pending.map((request) => request.url)).toEqual([
      'https://www.twse.com.tw/x?id=A',
      'https://www.twse.com.tw/x?id=B',
      'https://www.tpex.org.tw/y',
    ])

    pending[0].answer({ id: 'A' })
    await settle()
    expect(pending.map((request) => request.url)).toContain('https://www.twse.com.tw/x?id=C')
    for (const request of pending.slice(1)) request.answer({ ok: true })
    await expect(Promise.all([...twse, tpex])).resolves.toHaveLength(4)
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 0, waiting: 0 })
  })

  it('frees the slot during retry backoff, so parallel retries cannot deadlock', async () => {
    const attempts = new Map<string, number>()
    const order: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const id = new URL(String(input)).searchParams.get('id') ?? ''
        const attempt = (attempts.get(id) ?? 0) + 1
        attempts.set(id, attempt)
        order.push(`${id}${attempt}`)
        return attempt === 1
          ? new Response('busy', { status: 503 })
          : new Response(JSON.stringify({ id }), { status: 200 })
      })
    )
    const limiter = new HostLimiter({ maxConcurrent: 1, minGapMs: 0 })
    const sleep = async () => {
      await settle()
    }
    const results = await Promise.all(
      ['A', 'B'].map((id) => requestJson(`https://www.twse.com.tw/x?id=${id}`, { limiter, sleep }))
    )
    expect(results).toEqual([{ id: 'A' }, { id: 'B' }])
    // B's first attempt ran while A backed off, instead of waiting behind A's retry.
    expect(order).toEqual(['A1', 'B1', 'A2', 'B2'])
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 0, waiting: 0 })
  })

  it('leaves the queue when the caller aborts while it waits', async () => {
    const { pending, fetchMock } = stubPendingFetch()
    const limiter = new HostLimiter({ maxConcurrent: 1, minGapMs: 0 })
    const first = requestJson('https://www.twse.com.tw/x?id=A', { limiter })
    const controller = new AbortController()
    const queued = requestJson('https://www.twse.com.tw/x?id=B', { limiter, signal: controller.signal })
    await settle()
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 1, waiting: 1 })

    const reason = new Error('cancelled by client')
    controller.abort(reason)
    await expect(queued).rejects.toBe(reason)
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 1, waiting: 0 })

    pending[0].answer({ id: 'A' })
    await expect(first).resolves.toEqual({ id: 'A' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('starts the timeout when the request leaves the queue, not while it waits', async () => {
    const { pending } = stubPendingFetch()
    const limiter = new HostLimiter({ maxConcurrent: 1, minGapMs: 0 })
    const slow = requestJson('https://www.twse.com.tw/x?id=A', { limiter })
    const queued = requestJson('https://www.twse.com.tw/x?id=B', { limiter, timeoutMs: 30, maxRetries: 0 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    pending[0].answer({ id: 'A' })
    await slow
    await settle()
    pending[1].answer({ id: 'B' })
    await expect(queued).resolves.toEqual({ id: 'B' })
  })

  it('keeps the existing retry and error behaviour', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const limiter = new HostLimiter({ minGapMs: 0 })
    await expect(requestJson('https://www.twse.com.tw/missing', { limiter })).rejects.toThrow(
      'Request failed for www.twse.com.tw/missing after 1 attempt: HTTP 404'
    )
    expect(limiter.load('www.twse.com.tw')).toEqual({ active: 0, waiting: 0 })
  })
})

describe('RequestPacer', () => {
  it('pauses before a step only when the previous step went to the network', async () => {
    const sleep = vi.fn(async (_ms: number) => {})
    const pacer = new RequestPacer(200, sleep)
    await pacer.beforeStep() // first step: nothing before it
    pacer.onNetwork()
    await pacer.beforeStep() // after a network step: pause
    await pacer.beforeStep() // after a cached step: no pause
    pacer.onNetwork()
    pacer.onNetwork() // several requests in one step: still one pause
    await pacer.beforeStep()
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([200, 200])
  })

  it('stops at once when the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(new RequestPacer(200).beforeStep(controller.signal)).rejects.toThrow()
  })
})
