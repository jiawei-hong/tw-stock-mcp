import { errorDetail, getJson, isTransient, RETRY_DELAYS_MS } from './live/support.js'

// The live helper's retry rules, checked offline: a contract run should ride out a
// dropped connection, but never hide a real change in what the exchanges send.

// Pauses resolve at once and are recorded, so the retry delays cost no real time.
const { pauses } = vi.hoisted(() => ({ pauses: [] as number[] }))
vi.mock('node:timers/promises', () => ({
  setTimeout: async (ms: number) => {
    pauses.push(ms)
  },
}))

const connectTimeout = () =>
  Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })

/** Only the retry pauses, not the per-host spacing between requests. */
const retryPauses = () => pauses.filter((ms) => RETRY_DELAYS_MS.includes(ms))

describe('live test helper', () => {
  beforeEach(() => {
    pauses.length = 0
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('retries a dropped connection and returns the answer', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(connectTimeout()).mockResolvedValue(new Response('{"stat":"ok"}'))
    vi.stubGlobal('fetch', fetch)
    await expect(getJson('https://a.example/report')).resolves.toEqual({ stat: 'ok' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(retryPauses()).toEqual([RETRY_DELAYS_MS[0]])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('after fetch failed (UND_ERR_CONNECT_TIMEOUT)'))
  })

  it('gives up after three attempts at a 5xx, naming the cause', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('busy', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    await expect(getJson('https://b.example/report')).rejects.toThrow(/HTTP 503 .*3 attempts/)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(retryPauses()).toEqual(RETRY_DELAYS_MS)
  })

  it('fails at once on a 4xx or a body that is not JSON', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
      .mockResolvedValueOnce(new Response('<html>maintenance</html>'))
    vi.stubGlobal('fetch', fetch)
    await expect(getJson('https://c.example/report')).rejects.toThrow('HTTP 404')
    await expect(getJson('https://c.example/report')).rejects.toThrow('is not JSON')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(retryPauses()).toEqual([])
  })

  it('treats only connection failures and 429/5xx as transient', () => {
    expect(isTransient(connectTimeout())).toBe(true)
    expect(isTransient(new Error('stat is not ok'))).toBe(false)
    expect(isTransient(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(false)
    expect(errorDetail(connectTimeout())).toBe('fetch failed (UND_ERR_CONNECT_TIMEOUT)')
    expect(errorDetail(new Error('plain'))).toBe('plain')
  })
})
