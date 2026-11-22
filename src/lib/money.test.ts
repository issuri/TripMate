import { describe, expect, it } from 'vitest'
import { convertToHome, formatMinor, parseMajor, parseRateMicro, splitEvenly, splitByWeights } from './money'

describe('money', () => {
  it('parses without float error', () => {
    expect(parseMajor('0.1', 'USD')).toBe(10)
    expect(parseMajor('19.99', 'USD')).toBe(1999)
    expect(parseMajor('1,500', 'JPY')).toBe(1500)
    expect(parseMajor('1.5', 'JPY')).toBeNull()
    expect(parseMajor('abc', 'USD')).toBeNull()
  })
  it('formats', () => {
    expect(formatMinor(123456, 'USD')).toBe('1,234.56')
    expect(formatMinor(1500, 'KRW')).toBe('1,500')
  })
  it('converts to KRW with stored rate', () => {
    // 12.34 USD @ 1380.5 = 17035.37 → 17,035원
    expect(convertToHome(1234, 'USD', parseRateMicro('1380.5')!)).toBe(17035)
    // 1000 JPY @ 9.1234 = 9123.4 → 9,123원
    expect(convertToHome(1000, 'JPY', parseRateMicro('9.1234')!)).toBe(9123)
  })
  it('splits evenly and keeps the total exact', () => {
    expect(splitEvenly(10000, 3)).toEqual([3334, 3333, 3333])
    expect(splitEvenly(10000, 3).reduce((a, b) => a + b)).toBe(10000)
    expect(splitByWeights(1000, [1, 2, 1])).toEqual([250, 500, 250])
  })
})
