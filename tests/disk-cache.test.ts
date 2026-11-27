import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { twseDailyUrl, loadTpexDaily, loadTwseDaily, resetDailyQuotesCache, tpexDailyUrl } from '../src/core/daily-quotes.js'
import {
  CACHE_DIR_ENV,
  cacheIfClosedMonth,
  cacheIfPastDay,
  cacheIfSettled,
  DiskCache,
  diskCacheFromEnv,
  getDiskCache,
  isCompleteAnswer,
  resetDiskCache,
} from '../src/core/disk-cache.js'
import { historyUrl, loadBars, loadPage, resetHistoryCache } from '../src/core/history.js'
import { HostLimiter, requestJson } from '../src/core/http.js'
import { institutionalUrl, loadInstitutional, loadSummary, resetInstitutionalCache, summaryUrl } from '../src/core/institutional.js'
import { loadMargin, marginUrl, resetMarginCache } from '../src/core/margin.js'
import { stubFetch } from './fixtures.js'

// Envelopes as the exchanges send them (checked live 2026-11-25); rows trimmed.
const compact = (date: string) => date.replaceAll('-', '')
const roc = (iso: string) => `${Number(iso.slice(0, 4)) - 1911}/${iso.slice(5, 7)}/${iso.slice(8)}`
/** TWSE rwd: T86, BFI82U, STOCK_DAY carry rows in `data`. */
const twseData = (date: string, data: unknown[][]) => ({ stat: 'OK', date: compact(date), title: 'x', fields: [], data })
/** TWSE rwd: MI_INDEX, MI_MARGN carry rows in `tables`; MI_INDEX ends with an empty table. */
const twseTables = (date: string, tables: { title: string; data: unknown[][] }[]) => ({
  stat: 'OK',
  date: compact(date),
  tables: [...tables, {}],
})
/** TPEx: `date` YYYYMMDD at the top, ROC dates inside the tables. */
const tpexTables = (date: string, data: unknown[][]) => ({
  date: compact(date),
  tables: [{ title: 'x', date: roc(date), data }],
  stat: 'ok',
})
const twseNoData = { stat: '很抱歉，沒有符合條件的資料!', total: 0 }

const t86Row = ['2330', '台積電', ...Array.from({ length: 17 }, (_, index) => String(index * 1000))]
const summaryRows = [
  ['自營商(自行買賣)', '1', '2', '-1'],
  ['自營商(避險)', '1', '2', '-1'],
  ['投信', '1', '2', '-1'],
  ['外資及陸資(不含外資自營商)', '1', '2', '-1'],
  ['外資自營商', '1', '2', '-1'],
  ['合計', '5', '10', '-5'],
]
const stockDayRow = (date: string) => [roc(date), '1,000', '1,000,000', '1,000.00', '1,010.00', '990.00', '1,005.00', '+5.00', '100', '']

const PAST = '2026-11-13'
const TODAY = '2026-11-25'

let dir: string

async function filesIn(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await walk(child)
      else found.push(child.slice(root.length + 1))
    }
  }
  await walk(root)
  return found.sort()
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tw-stock-mcp-cache-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete process.env[CACHE_DIR_ENV]
  resetDiskCache()
  await rm(dir, { recursive: true, force: true })
})

describe('cache policies', () => {
  const now = new Date('2026-11-25T04:00:00Z') // noon in Taipei

  it('marks only days before today in Asia/Taipei', () => {
    expect(cacheIfPastDay('2026-11-24', now)).toEqual({ mode: 'immutable', date: '2026-11-24' })
    expect(cacheIfPastDay('2026-11-25', now)).toBeUndefined()
    // 23:30 UTC on the 24th is already the 25th in Taipei.
    expect(cacheIfPastDay('2026-11-25', new Date('2026-11-24T23:30:00Z'))).toBeUndefined()
  })

  it('marks only months that have ended', () => {
    expect(cacheIfClosedMonth('2026-10', now)).toEqual({ mode: 'immutable', date: '2026-10' })
    expect(cacheIfClosedMonth('2026-11', now)).toBeUndefined()
    // 1 Dec 00:30 in Taipei: November has ended.
    expect(cacheIfClosedMonth('2026-11', new Date('2026-11-30T16:30:00Z'))).toEqual({ mode: 'immutable', date: '2026-11' })
  })

  it('marks restatable reports only once they are 14 calendar days old', () => {
    expect(cacheIfSettled('2026-11-11', now)).toEqual({ mode: 'immutable', date: '2026-11-11' })
    expect(cacheIfSettled('2026-11-12', now)).toBeUndefined()
    expect(cacheIfSettled('2026-11-24', now)).toBeUndefined()
    // Across a month boundary.
    expect(cacheIfSettled('2026-10-31', new Date('2026-11-14T04:00:00Z'))).toEqual({ mode: 'immutable', date: '2026-10-31' })
  })
})

describe('isCompleteAnswer', () => {
  const day = { mode: 'immutable', date: PAST } as const

  it('accepts TWSE and TPEx answers with rows for the requested day', () => {
    expect(isCompleteAnswer(twseData(PAST, [t86Row]), day)).toBe(true)
    expect(isCompleteAnswer(twseTables(PAST, [{ title: '信用交易統計', data: [] }, { title: '融資融券彙總', data: [['2330']] }]), day)).toBe(true)
    expect(isCompleteAnswer(tpexTables(PAST, [['6488']]), day)).toBe(true)
  })

  it('accepts a STOCK_DAY answer, which echoes the 1st of the month, for that month', () => {
    const month = { mode: 'immutable', date: '2026-10' } as const
    expect(isCompleteAnswer(twseData('2026-10-01', [stockDayRow('2026-10-01')]), month)).toBe(true)
    expect(isCompleteAnswer(twseData('2026-09-01', [stockDayRow('2026-09-01')]), month)).toBe(false)
  })

  it('refuses no-data answers on both exchanges', () => {
    expect(isCompleteAnswer(twseNoData, day)).toBe(false)
    expect(isCompleteAnswer({ stat: '很抱歉，沒有符合條件的資料' }, day)).toBe(false)
    expect(isCompleteAnswer(tpexTables(PAST, []), day)).toBe(false)
    expect(isCompleteAnswer(twseTables(PAST, [{ title: '每日收盤行情', data: [] }]), day)).toBe(false)
  })

  it('refuses an answer for another day, as TPEx stk_quote_result.php gives', () => {
    expect(isCompleteAnswer(tpexTables(TODAY, [['6488']]), day)).toBe(false)
  })

  it('refuses anything without a status, a date or a known shape', () => {
    expect(isCompleteAnswer({ date: compact(PAST), data: [t86Row] }, day)).toBe(false)
    expect(isCompleteAnswer({ stat: 'OK', data: [t86Row] }, day)).toBe(false)
    expect(isCompleteAnswer({ stat: 'OK', date: '115/11/13', data: [t86Row] }, day)).toBe(false)
    expect(isCompleteAnswer({ stat: 'OK', date: compact(PAST), rows: [t86Row] }, day)).toBe(false)
    expect(isCompleteAnswer([twseData(PAST, [t86Row])], day)).toBe(false)
    expect(isCompleteAnswer(null, day)).toBe(false)
  })
})

describe('DiskCache', () => {
  const url = institutionalUrl(PAST, 'tse')
  const policy = { mode: 'immutable', date: PAST } as const
  const answer = twseData(PAST, [t86Row])

  it('writes atomically under a versioned directory and reads the answer back', async () => {
    const cache = new DiskCache({ dir })
    expect(cache.root).toBe(join(dir, 'v1'))
    await expect(cache.write(url, policy, answer)).resolves.toBe(true)

    const files = await filesIn(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^v1\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/)
    expect(join(dir, files[0])).toBe(cache.fileFor(url))
    const entry = JSON.parse(await readFile(cache.fileFor(url), 'utf8'))
    expect(entry).toMatchObject({ version: 1, url, body: '', date: PAST, data: answer })

    await expect(new DiskCache({ dir }).read(url, policy)).resolves.toEqual(answer)
  })

  it('keys entries by URL and request body', () => {
    const cache = new DiskCache({ dir })
    expect(cache.fileFor(url)).not.toBe(cache.fileFor(institutionalUrl('2026-11-12', 'tse')))
    expect(cache.fileFor(url, 'a=1')).not.toBe(cache.fileFor(url))
    expect(cache.fileFor(url)).toBe(new DiskCache({ dir }).fileFor(url))
  })

  it('never writes no-data answers or answers for another day', async () => {
    const cache = new DiskCache({ dir })
    await expect(cache.write(url, policy, twseNoData)).resolves.toBe(false)
    await expect(cache.write(url, policy, twseData(TODAY, [t86Row]))).resolves.toBe(false)
    expect(await filesIn(dir)).toEqual([])
    await expect(cache.read(url, policy)).resolves.toBeUndefined()
  })

  it('deletes a corrupt, truncated or old-format file and reports a miss', async () => {
    const cache = new DiskCache({ dir })
    const file = cache.fileFor(url)
    await mkdir(dirname(file), { recursive: true })
    for (const text of [
      '{"version":1,"url":',
      JSON.stringify({ version: 0, url, body: '', data: answer }),
      JSON.stringify({ version: 1, url: 'https://elsewhere/', body: '', data: answer }),
      JSON.stringify({ version: 1, url, body: '', data: twseNoData }),
    ]) {
      await writeFile(file, text)
      await expect(cache.read(url, policy)).resolves.toBeUndefined()
      await expect(stat(file)).rejects.toThrow()
    }
  })

  it('reports a disk it cannot write to and carries on', async () => {
    const blocker = join(dir, 'not-a-directory')
    await writeFile(blocker, '')
    const onError = vi.fn()
    const cache = new DiskCache({ dir: blocker, onError })
    await expect(cache.write(url, policy, answer)).resolves.toBe(false)
    await expect(cache.read(url, policy)).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalled()
  })

  it('evicts the least recently used files once the cap is passed', async () => {
    const entryBytes = (await (async () => {
      const probe = new DiskCache({ dir: join(dir, 'probe') })
      await probe.write(url, policy, answer)
      return (await stat(probe.fileFor(url))).size
    })())
    const cache = new DiskCache({ dir: join(dir, 'lru'), maxBytes: Math.floor(entryBytes * 3.5) })
    const days = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']
    const urls = days.map((day) => institutionalUrl(day, 'tse'))
    const write = (index: number) => cache.write(urls[index], { mode: 'immutable', date: days[index] }, twseData(days[index], [t86Row]))

    for (const index of [0, 1, 2]) {
      await write(index)
      const time = new Date(Date.UTC(2026, 10, 20, 0, index))
      await utimes(cache.fileFor(urls[index]), time, time)
    }
    // Reading the oldest makes it the most recently used.
    await expect(cache.read(urls[0], { mode: 'immutable', date: days[0] })).resolves.toBeDefined()
    await write(3)

    const exists = (index: number) => stat(cache.fileFor(urls[index])).then(() => true, () => false)
    expect(await Promise.all([0, 1, 2, 3].map(exists))).toEqual([true, false, false, true])
  })

  it('removes temporary files left behind by a crash', async () => {
    const cache = new DiskCache({ dir })
    const shard = join(cache.root, 'ab')
    await mkdir(shard, { recursive: true })
    const stale = join(shard, `${'a'.repeat(64)}.json.1.dead.tmp`)
    const fresh = join(shard, `${'b'.repeat(64)}.json.2.live.tmp`)
    await writeFile(stale, '{')
    await writeFile(fresh, '{')
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    await utimes(stale, old, old)

    await cache.write(url, policy, answer)
    await expect(stat(stale)).rejects.toThrow()
    await expect(stat(fresh)).resolves.toBeDefined()
  })
})

describe('diskCacheFromEnv', () => {
  it('is off unless TW_STOCK_MCP_CACHE_DIR is set', () => {
    expect(diskCacheFromEnv({})).toBeNull()
    expect(diskCacheFromEnv({ [CACHE_DIR_ENV]: '  ' })).toBeNull()
    expect(getDiskCache()).toBeNull()
  })

  it('resolves the directory, expands ~ and reads the size cap', () => {
    expect(diskCacheFromEnv({ [CACHE_DIR_ENV]: dir })?.root).toBe(join(dir, 'v1'))
    expect(diskCacheFromEnv({ [CACHE_DIR_ENV]: '~/.cache/tw' })?.root).toBe(join(homedir(), '.cache/tw', 'v1'))
    expect(diskCacheFromEnv({ [CACHE_DIR_ENV]: dir })?.maxBytes).toBe(512 * 1024 * 1024)
    expect(diskCacheFromEnv({ [CACHE_DIR_ENV]: dir, TW_STOCK_MCP_CACHE_MAX_MB: '64' })?.maxBytes).toBe(64 * 1024 * 1024)
    expect(diskCacheFromEnv({ [CACHE_DIR_ENV]: dir, TW_STOCK_MCP_CACHE_MAX_MB: 'lots' })?.maxBytes).toBe(512 * 1024 * 1024)
  })
})

describe('requestJson with the disk cache', () => {
  const url = institutionalUrl(PAST, 'tse')
  const policy = { mode: 'immutable', date: PAST } as const

  function enable() {
    process.env[CACHE_DIR_ENV] = dir
    resetDiskCache()
  }

  it('calls onNetwork only when the answer comes from the exchange', async () => {
    enable()
    stubFetch({ 'www.twse.com.tw': () => twseData(PAST, [t86Row]) })
    const onNetwork = vi.fn()
    await requestJson(url, { cache: policy, onNetwork })
    await requestJson(url, { cache: policy, onNetwork })
    expect(onNetwork).toHaveBeenCalledTimes(1)
  })

  it('answers an immutable request from disk without touching the network or the queue', async () => {
    enable()
    const { fetchMock } = stubFetch({ 'www.twse.com.tw': () => twseData(PAST, [t86Row]) })
    await expect(requestJson(url, { cache: policy })).resolves.toEqual(twseData(PAST, [t86Row]))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A full queue does not hold up a disk hit.
    const limiter = new HostLimiter({ maxConcurrent: 1, minGapMs: 0 })
    await limiter.acquire('www.twse.com.tw')
    await expect(requestJson(url, { cache: policy, limiter })).resolves.toEqual(twseData(PAST, [t86Row]))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does nothing on disk when the cache is off or the request is not marked', async () => {
    const { fetchMock } = stubFetch({ 'www.twse.com.tw': () => twseData(PAST, [t86Row]) })
    await requestJson(url, { cache: policy })
    enable()
    await requestJson(url)
    await requestJson(url)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(await filesIn(dir)).toEqual([])
  })

  it('never stores errors or no-data answers', async () => {
    enable()
    let reply: () => unknown = () => new Response('down', { status: 404 })
    const { fetchMock } = stubFetch({ 'www.twse.com.tw': () => reply() })
    await expect(requestJson(url, { cache: policy })).rejects.toThrow('HTTP 404')
    reply = () => twseNoData
    await expect(requestJson(url, { cache: policy })).resolves.toEqual(twseNoData)
    expect(await filesIn(dir)).toEqual([])
    reply = () => twseData(PAST, [t86Row])
    await requestJson(url, { cache: policy })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(await filesIn(dir)).toHaveLength(1)
  })

  it('refetches and replaces a corrupt file', async () => {
    enable()
    const file = new DiskCache({ dir }).fileFor(url)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'not json')
    const { fetchMock } = stubFetch({ 'www.twse.com.tw': () => twseData(PAST, [t86Row]) })
    await expect(requestJson(url, { cache: policy })).resolves.toEqual(twseData(PAST, [t86Row]))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(file, 'utf8')).data).toEqual(twseData(PAST, [t86Row]))
  })
})

describe('call sites', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T04:00:00Z')) // Wednesday noon in Taipei
    process.env[CACHE_DIR_ENV] = dir
    resetDiskCache()
    resetInstitutionalCache()
    resetMarginCache()
    resetDailyQuotesCache()
    resetHistoryCache()
  })

  const cached = (url: string) => stat(new DiskCache({ dir }).fileFor(url)).then(() => true, () => false)

  it('keeps past institutional days and the market summary, not today', async () => {
    const { fetchMock } = stubFetch({
      // Both already send YYYYMMDD, which twseData passes through.
      'www.twse.com.tw': (url) =>
        url.pathname.endsWith('BFI82U')
          ? twseData(url.searchParams.get('dayDate') ?? '', summaryRows)
          : twseData(url.searchParams.get('date') ?? '', [t86Row]),
      'www.tpex.org.tw': () => tpexTables(PAST, [['6488', '環球晶', ...Array.from({ length: 23 }, () => '0')]]),
    })
    const first = await loadInstitutional(PAST, 'tse')
    await loadInstitutional(PAST, 'otc')
    await loadSummary(PAST)
    await loadInstitutional(TODAY, 'tse')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(await cached(institutionalUrl(PAST, 'tse'))).toBe(true)
    expect(await cached(institutionalUrl(PAST, 'otc'))).toBe(true)
    expect(await cached(summaryUrl(PAST))).toBe(true)
    expect(await cached(institutionalUrl(TODAY, 'tse'))).toBe(false)

    // A new session (empty memory cache) reads past days from disk.
    resetInstitutionalCache()
    await expect(loadInstitutional(PAST, 'tse')).resolves.toEqual(first)
    await loadSummary(PAST)
    await loadInstitutional(TODAY, 'tse')
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('keeps margin days on both exchanges only once they have settled', async () => {
    // Margin balances are provisional until the next day's report: a recent day stays off disk.
    const SETTLED = '2026-11-06'
    stubFetch({
      'www.twse.com.tw': (url) => {
        const date = url.searchParams.get('date') ?? ''
        const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`
        return twseTables(iso, [{ title: '信用交易統計', data: [] }, { title: '融資融券彙總 (全部)', data: [['2330']] }])
      },
      'www.tpex.org.tw': (url) => {
        const [year, month, day] = (url.searchParams.get('d') ?? '').split('/')
        return tpexTables(`${Number(year) + 1911}-${month}-${day}`, [['6488']])
      },
    })
    for (const date of [PAST, SETTLED]) {
      await loadMargin(date, 'tse')
      await loadMargin(date, 'otc')
    }
    expect(await cached(marginUrl(PAST, 'tse'))).toBe(false)
    expect(await cached(marginUrl(PAST, 'otc'))).toBe(false)
    expect(await cached(marginUrl(SETTLED, 'tse'))).toBe(true)
    expect(await cached(marginUrl(SETTLED, 'otc'))).toBe(true)
  })

  it('keeps past TWSE daily quotes, and not a TPEx answer for the wrong day', async () => {
    stubFetch({
      'www.twse.com.tw': () => twseTables(PAST, [{ title: '每日收盤行情', data: [['2330', '台積電', '1', '1', '1', '1', '1', '1', '1005', '+', '5']] }]),
      // An answer for another day, as the older stk_quote_result.php gave whatever `d` said.
      'www.tpex.org.tw': () => tpexTables(TODAY, [['6488', '環球晶', '700']]),
    })
    await loadTwseDaily(PAST)
    await loadTpexDaily(PAST)
    expect(await cached(twseDailyUrl(PAST))).toBe(true)
    expect(await cached(tpexDailyUrl(PAST))).toBe(false)
  })

  it('keeps closed months of history, not the current month', async () => {
    const { fetchMock } = stubFetch({
      'www.twse.com.tw': (url) => {
        const date = url.searchParams.get('date') ?? ''
        const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-02`
        return twseData(`${iso.slice(0, 8)}01`, [stockDayRow(iso)])
      },
    })
    await loadBars('2330', 'tse', ['2026-10', '2026-11'])
    expect(await cached(historyUrl('2330', '2026-10', 'tse'))).toBe(true)
    expect(await cached(historyUrl('2330', '2026-11', 'tse'))).toBe(false)

    resetHistoryCache()
    const bars = await loadBars('2330', 'tse', ['2026-10', '2026-11'])
    expect(bars.map((bar) => bar.date)).toEqual(['2026-10-02', '2026-11-02'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('counts a history page answered from disk as cached, so the page loop does not pause after it', async () => {
    const { fetchMock } = stubFetch({ 'www.twse.com.tw': () => twseData('2026-10-01', [stockDayRow('2026-10-02')]) })
    const page = () => loadPage(historyUrl('2330', '2026-10', 'tse'), 60_000, (data) => data, undefined, { mode: 'immutable', date: '2026-10' })
    expect((await page()).cached).toBe(false)
    resetHistoryCache()
    expect((await page()).cached).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
