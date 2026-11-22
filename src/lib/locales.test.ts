import { describe, expect, it } from 'vitest'
import { validateTrip } from '../db/trips'
import { CURRENCIES, CURRENCY_LIST, otherCurrencies, TIME_ZONES, withCurrent } from './locales'
import { convertToHome, formatMinor, minorDigits, parseMajor } from './money'
import { isValidTimeZone } from './tz'

describe('time zone list', () => {
  it('has many places, no duplicates, and every name is a real time zone (so notifications fire at the right local time)', () => {
    expect(TIME_ZONES.length).toBeGreaterThanOrEqual(70)
    const ids = TIME_ZONES.map(([id]) => id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(isValidTimeZone(id), id).toBe(true)
  })
  it('the old short list is still available', () => {
    const ids = TIME_ZONES.map(([id]) => id)
    for (const id of ['Asia/Seoul', 'Asia/Tokyo', 'Asia/Bangkok', 'Asia/Taipei', 'Asia/Singapore', 'Europe/Paris', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney']) expect(ids).toContain(id)
  })
  it('every listed zone is accepted when creating a trip', () => {
    for (const [id] of TIME_ZONES) expect(validateTrip({ name: 'x', country: '', city: '', startDate: '2030-05-10', endDate: '2030-05-12', timeZone: id }), id).toBeNull()
  })
})

describe('time zone names', () => {
  it('every entry has a Korean place name (no raw zone ids like "Asia/Karachi" shown as the name)', () => {
    for (const [id, label] of TIME_ZONES) {
      expect(/[가-힣]/.test(label), `${id} → ${label}`).toBe(true)
      expect(label.includes('/'), `${id} → ${label}`).toBe(false)
    }
  })
  it('keeps the places added for completeness', () => {
    const ids = TIME_ZONES.map(([id]) => id)
    for (const id of ['Asia/Karachi', 'America/Panama', 'Europe/Kyiv', 'Pacific/Tahiti', 'Asia/Kuwait']) expect(ids, id).toContain(id)
  })
})

describe('currency list', () => {
  it('has many currencies, valid unique 3-letter codes', () => {
    expect(CURRENCIES.length).toBeGreaterThanOrEqual(50)
    expect(new Set(CURRENCIES).size).toBe(CURRENCIES.length)
    for (const c of CURRENCIES) expect(c).toMatch(/^[A-Z]{3}$/)
    for (const c of ['KRW', 'JPY', 'USD', 'EUR', 'GBP', 'CNY', 'THB', 'TWD', 'VND', 'SGD']) expect(CURRENCIES).toContain(c)
    expect(CURRENCY_LIST.every(([, label]) => label.length > 0)).toBe(true)
  })
  it('decimal places match the real currency (a wrong value would make amounts 100x off)', () => {
    for (const c of CURRENCIES) {
      const real = new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits
      if (c === 'IDR') continue   // 법정 소수 2자리지만 실제로는 소수 없이 쓰므로 0으로 다룬다(예전부터의 결정)
      expect(minorDigits(c), c).toBe(real)
    }
  })
  it('amounts parse with the right number of decimals', () => {
    expect(parseMajor('1500', 'CLP')).toBe(1500)
    expect(parseMajor('12.5', 'CLP')).toBeNull()
    expect(parseMajor('12.50', 'CHF')).toBe(1250)
    expect(parseMajor('99', 'ISK')).toBe(99)
  })
  it('no currency the device knows is missing: listed ones plus the "all others" group cover everything usable', () => {
    const all = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('currency')
    const covered = new Set([...CURRENCIES, ...otherCurrencies()])
    const skipped = new Set(['XDR', 'XSU', 'HRK', 'SLL', 'ZWL'])
    const missing = all.filter((c) => !covered.has(c) && !skipped.has(c))
    expect(missing).toEqual([])
    expect(otherCurrencies().some((c) => CURRENCIES.includes(c))).toBe(false)
    for (const c of ['KWD', 'CRC', 'XOF', 'PKR', 'UAH', 'GEL', 'JOD']) expect(covered.has(c), c).toBe(true)
  })
  it('every currency has a working amount round trip with its real decimals, including 3-decimal ones', () => {
    for (const c of new Set([...CURRENCIES, ...otherCurrencies()])) {
      const d = minorDigits(c)
      const real = new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits
      if (c !== 'IDR') expect(d, c).toBe(real)
      const text = d ? '12.' + '3456'.slice(0, d).padEnd(d, '0') : '12'
      const minor = parseMajor(text, c)
      expect(minor, c).not.toBeNull()
      expect(formatMinor(minor!, c).replace(/,/g, ''), c).toBe(text)
      expect(parseMajor('1.' + '1'.repeat(d + 1), c), c).toBeNull()        // 허용 자릿수 초과는 거부
      expect(convertToHome(minor!, c, 1_000_000)).toBeGreaterThan(0)
    }
    expect(parseMajor('1.234', 'KWD')).toBe(1234)
    expect(convertToHome(1000, 'KWD', 4_400_000_000)).toBe(4400)          // 1.000 KWD × 4,400원 = 4,400원 (3자리 통화도 100배·1000배 어긋나지 않는다)
    expect(convertToHome(1500, 'KWD', 4_400_000_000)).toBe(6600)
  })
  it('a currency or zone saved before is kept in the picker even if it is not on the list', () => {
    expect(withCurrent(CURRENCIES, 'XYZ')[0]).toBe('XYZ')
    expect(withCurrent(CURRENCIES, 'KRW')).toEqual(CURRENCIES)
  })
})
