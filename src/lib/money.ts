// 금액은 항상 "최소 통화 단위 정수"(원, 센트 등)로 다룬다. 부동소수점 연산 금지.
// 환율은 micro 정수(1 현지단위 = rateMicro/1e6 원)로 저장한다.

const MINOR_DIGITS: Record<string, number> = {
  KRW: 0, JPY: 0, VND: 0, IDR: 0, CLP: 0, ISK: 0, LAK: 0, MMK: 0, HUF: 0, COP: 0, TWD: 2, USD: 2, EUR: 2, GBP: 2, CNY: 2, THB: 2, SGD: 2, HKD: 2, AUD: 2, CAD: 2,
}

const intlDigits = new Map<string, number>()
/** 위 표에 없는 통화는 브라우저가 아는 실제 소수 자릿수를 쓴다(쿠웨이트 디나르처럼 3자리인 통화가 있다). 알 수 없으면 2. */
export const minorDigits = (currency: string): number => {
  const known = MINOR_DIGITS[currency]
  if (known !== undefined) return known
  let d = intlDigits.get(currency)
  if (d === undefined) {
    try { d = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2 } catch { d = 2 }
    intlDigits.set(currency, d)
  }
  return d
}

/** "12.34" → 1234 (USD). 소수 자릿수 초과/잘못된 입력은 null. 문자열 기반이라 부동소수점 오차 없음. */
export function parseMajor(input: string, currency: string): number | null {
  let s = input.trim()
  // 쉼표는 올바른 천 단위 구분(1,234 / 1,234,567.89)일 때만 허용한다.
  // "1,50"처럼 쉼표를 소수점으로 쓴 입력을 쉼표 제거로 읽으면 150이 되어 금액이 100배가 되므로 거부한다.
  if (s.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) return null
    s = s.replace(/,/g, '')
  }
  const digits = minorDigits(currency)
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s)
  if (!m) return null
  const frac = m[2] ?? ''
  if (frac.length > digits) return null
  const minor = BigInt(m[1] + frac.padEnd(digits, '0'))
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(minor)
}

export function formatMinor(minor: number, currency: string): string {
  const digits = minorDigits(currency)
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  const base = 10 ** digits
  const whole = Math.floor(abs / base).toLocaleString('en-US')
  const frac = digits ? '.' + String(abs % base).padStart(digits, '0') : ''
  return `${sign}${whole}${frac}`
}

/** "9.1234" → 9123400 (micro). 최대 6자리 소수. */
export function parseRateMicro(input: string): number | null {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(input.trim())
  if (!m) return null
  const v = Number(BigInt(m[1]) * 1000000n + BigInt((m[2] ?? '').padEnd(6, '0')))
  return v > 0 ? v : null
}

/** 현지 통화 최소단위 → 원화(최소단위) 환산. 반올림(half up), BigInt로 계산. */
export function convertToHome(localMinor: number, localCurrency: string, rateMicro: number, homeCurrency = 'KRW'): number {
  // home = localMajor * rate = (localMinor / 10^ld) * (rateMicro / 1e6); homeMinor = home * 10^hd
  const ld = BigInt(minorDigits(localCurrency))
  const hd = BigInt(minorDigits(homeCurrency))
  const num = BigInt(localMinor) * BigInt(rateMicro) * 10n ** hd
  const den = 1000000n * 10n ** ld
  return Number((num * 2n + den) / (den * 2n))
}

/** total을 weights 비율로 정수 분배. 합계가 항상 total과 정확히 일치(나머지는 앞사람부터 1씩). */
export function splitByWeights(total: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('total must be a non-negative integer')
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new Error('weights must be non-negative integers')
  const sum = weights.reduce((a, b) => a + b, 0)
  if (weights.length === 0 || sum <= 0) throw new Error('weights must be positive')
  const out = weights.map((w) => Math.floor((total * w) / sum))
  let rest = total - out.reduce((a, b) => a + b, 0)
  for (let i = 0; rest > 0; i = (i + 1) % out.length) {
    if (weights[i] > 0) { out[i] += 1; rest -= 1 }
  }
  return out
}

export const splitEvenly = (total: number, n: number) => splitByWeights(total, Array(n).fill(1))
