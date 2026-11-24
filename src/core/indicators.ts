import type { DailyBar } from './history.js'

export const INDICATORS = ['rsi', 'macd', 'kd', 'bollinger'] as const
export type Indicator = (typeof INDICATORS)[number]

export type Macd = { macd: number | null; signal: number | null; histogram: number | null }
export type Kd = { k: number | null; d: number | null }
export type BollingerBands = { upper: number | null; middle: number | null; lower: number | null }
export type IndicatorValues = { rsi?: number | null; macd?: Macd; kd?: Kd; bollinger?: BollingerBands }

const RSI_PERIOD = 14
const MACD_FAST = 12
const MACD_SLOW = 26
const MACD_SIGNAL = 9
const KD_PERIOD = 9
const BOLLINGER_PERIOD = 20
const BOLLINGER_WIDTH = 2

/**
 * Daily bars each indicator needs before a bar. `required`: for its value there
 * to be defined. `preferred`: for a smoothed indicator's starting value to have
 * faded (to about 1% weight), so it matches one computed from the full history.
 */
export const INDICATOR_WARMUP: Record<Indicator, { required: number; preferred: number }> = {
  // Wilder smoothing keeps (13/14)^60 ≈ 1% of the seed after 60 more days.
  rsi: { required: RSI_PERIOD, preferred: RSI_PERIOD + 60 },
  // EMA26 keeps (25/27)^60 ≈ 1%; the signal line needs 8 more MACD values.
  macd: { required: MACD_SLOW - 1 + MACD_SIGNAL - 1, preferred: MACD_SLOW - 1 + 60 },
  // K and D keep (2/3)^20 < 0.1% of the initial 50.
  kd: { required: KD_PERIOD - 1, preferred: KD_PERIOD - 1 + 20 },
  bollinger: { required: BOLLINGER_PERIOD - 1, preferred: BOLLINGER_PERIOD - 1 },
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits

/** EMA seeded with the simple average of its first `period` values; leading nulls are skipped. Unrounded. */
function ema(values: readonly (number | null)[], period: number): (number | null)[] {
  const weight = 2 / (period + 1)
  const result: (number | null)[] = []
  let seen = 0
  let total = 0
  let current: number | null = null
  for (const value of values) {
    if (value === null) {
      result.push(current)
      continue
    }
    if (current === null) {
      total += value
      seen += 1
      if (seen === period) current = total / period
    } else {
      current += weight * (value - current)
    }
    result.push(current)
  }
  return result
}

/**
 * RSI with Wilder smoothing, 0-100 (50 when the price did not move). The first
 * average is the mean of the first `period` changes; null until then.
 */
export function rsi(closes: readonly number[], period = RSI_PERIOD): (number | null)[] {
  let gain = 0
  let loss = 0
  return closes.map((close, index) => {
    if (index === 0) return null
    const change = close - closes[index - 1]
    const up = Math.max(change, 0)
    const down = Math.max(-change, 0)
    if (index <= period) {
      gain += up / period
      loss += down / period
      if (index < period) return null
    } else {
      gain = (gain * (period - 1) + up) / period
      loss = (loss * (period - 1) + down) / period
    }
    return gain + loss === 0 ? 50 : round((100 * gain) / (gain + loss))
  })
}

/** MACD line (fast EMA - slow EMA), its signal EMA and the histogram (line - signal). */
export function macd(
  closes: readonly number[],
  fast = MACD_FAST,
  slow = MACD_SLOW,
  signal = MACD_SIGNAL
): Macd[] {
  const fastLine = ema(closes, fast)
  const slowLine = ema(closes, slow)
  const line = fastLine.map((fastValue, index) => {
    const slowValue = slowLine[index]
    return fastValue === null || slowValue === null ? null : fastValue - slowValue
  })
  const signalLine = ema(line, signal)
  return line.map((value, index) => {
    const average = signalLine[index]
    return {
      macd: value === null ? null : round(value, 4),
      signal: average === null ? null : round(average, 4),
      histogram: value === null || average === null ? null : round(value - average, 4),
    }
  })
}

/**
 * Stochastic KD as charted in Taiwan: RSV = (close - lowest low) / (highest high -
 * lowest low) x 100 over `period` days (50 when that range is zero),
 * K = 2/3 K + 1/3 RSV, D = 2/3 D + 1/3 K, starting from K = D = 50.
 */
export function kd(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period = KD_PERIOD
): Kd[] {
  let k = 50
  let d = 50
  return closes.map((close, index) => {
    if (index + 1 < period) return { k: null, d: null }
    const from = index + 1 - period
    const high = Math.max(...highs.slice(from, index + 1))
    const low = Math.min(...lows.slice(from, index + 1))
    const rsv = high === low ? 50 : ((close - low) / (high - low)) * 100
    k = (2 * k + rsv) / 3
    d = (2 * d + k) / 3
    return { k: round(k), d: round(d) }
  })
}

/** Bollinger Bands: simple moving average +/- `width` population standard deviations. */
export function bollinger(
  closes: readonly number[],
  period = BOLLINGER_PERIOD,
  width = BOLLINGER_WIDTH
): BollingerBands[] {
  return closes.map((_, index) => {
    if (index + 1 < period) return { upper: null, middle: null, lower: null }
    const window = closes.slice(index + 1 - period, index + 1)
    const mean = window.reduce((total, close) => total + close, 0) / period
    const deviation = Math.sqrt(window.reduce((total, close) => total + (close - mean) ** 2, 0) / period)
    return {
      upper: round(mean + width * deviation, 4),
      middle: round(mean, 4),
      lower: round(mean - width * deviation, 4),
    }
  })
}

/**
 * The requested indicators at every daily bar, keyed in `INDICATORS` order with
 * default parameters. A missing high or low counts as the close.
 */
export function indicatorSeries(bars: readonly DailyBar[], names: readonly Indicator[]): IndicatorValues[] {
  const closes = bars.map((bar) => bar.close)
  const compute: Record<Indicator, () => readonly unknown[]> = {
    rsi: () => rsi(closes),
    macd: () => macd(closes),
    kd: () => kd(bars.map((bar) => bar.high ?? bar.close), bars.map((bar) => bar.low ?? bar.close), closes),
    bollinger: () => bollinger(closes),
  }
  const columns = INDICATORS.filter((name) => names.includes(name)).map((name) => [name, compute[name]()] as const)
  return bars.map(
    (_, index) => Object.fromEntries(columns.map(([name, values]) => [name, values[index]])) as IndicatorValues
  )
}
