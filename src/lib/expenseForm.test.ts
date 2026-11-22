import { describe, expect, it } from 'vitest'
import type { Money } from '../db/types'
import { buildMoney, computeAmounts, defaultRateText, initialSplitMode, type FormState } from './expenseForm'
import { splitEqual } from './split'

const f = (o: Partial<FormState> = {}): FormState => ({ local: '1,500', cur: 'JPY', rate: '9.1234', home: '', last: 'rate', shared: false, payer: 'self', picked: [], mode: 'equal', custom: {}, seed: 'exp1', ...o })
const clean = { money: false, split: false }

describe('computeAmounts', () => {
  it('KRW needs no rate; foreign currency converts exactly; entering won derives the rate', () => {
    expect(computeAmounts(f({ cur: 'KRW', local: '12,000' }))).toEqual({ localMinor: 12000, rateMicro: 1_000_000, homeMinor: 12000 })
    expect(computeAmounts(f())).toEqual({ localMinor: 1500, rateMicro: 9_123_400, homeMinor: 13685 })
    expect(computeAmounts(f({ last: 'home', home: '14000' }))).toMatchObject({ localMinor: 1500, homeMinor: 14000, rateMicro: 9_333_333 })
  })
  it('returns nothing for empty/invalid input, and no home amount when the rate is missing', () => {
    expect(computeAmounts(f({ local: '' })).localMinor).toBeNull()
    expect(computeAmounts(f({ local: '0' })).localMinor).toBeNull()
    expect(computeAmounts(f({ local: '1,50' })).localMinor).toBeNull()
    expect(computeAmounts(f({ rate: '' }))).toMatchObject({ localMinor: 1500, rateMicro: null, homeMinor: null })
    expect(computeAmounts(f({ rate: 'abc' })).homeMinor).toBeNull()
  })
})

describe('buildMoney: untouched values are never recomputed', () => {
  const direct: Money = { localMinor: 1500, currency: 'JPY', rateMicro: 9_333_333, homeMinor: 14000, shared: false, payer: 'self', splits: [] }
  it('opening and saving an expense whose won amount was typed by hand does not move the amount (no rounding drift)', () => {
    // 폼이 저장된 환율(9.333333)로 다시 계산하면 13,999.9995 → 14,000 이 아니라 1원씩 어긋날 수 있다
    const r = buildMoney(f({ local: '1500', rate: '9.333333', last: 'rate' }), direct, clean)
    expect(r).toEqual({ ok: true, money: direct })
  })
  it('a custom (non-equal) split survives editing something else, e.g. only the memo', () => {
    const m: Money = { localMinor: 30000, currency: 'KRW', rateMicro: 1e6, homeMinor: 30000, shared: true, payer: 'self', splits: [{ k: 'self', s: 5000 }, { k: 'a', s: 20000 }, { k: 'b', s: 5000 }] }
    expect(initialSplitMode(m, 'e')).toBe('custom')
    const r = buildMoney(f({ cur: 'KRW', local: '30000', shared: true, picked: ['self', 'a', 'b'], mode: initialSplitMode(m, 'e') }), m, clean)
    expect(r).toEqual({ ok: true, money: m })
  })
  it('detects an equal split as equal, including the extra-won distribution', () => {
    const m: Money = { localMinor: 100, currency: 'KRW', rateMicro: 1e6, homeMinor: 100, shared: true, payer: 'self', splits: splitEqual(100, ['self', 'a', 'b'], 'e') }
    expect(initialSplitMode(m, 'e')).toBe('equal')
  })
  it('changing only the amount of a shared expense rescales the existing proportions and keeps the total exact', () => {
    const m: Money = { localMinor: 1000, currency: 'KRW', rateMicro: 1e6, homeMinor: 1000, shared: true, payer: 'self', splits: [{ k: 'self', s: 250 }, { k: 'a', s: 750 }] }
    const r = buildMoney(f({ cur: 'KRW', local: '2000', shared: true, picked: ['self', 'a'], mode: 'custom' }), m, { money: true, split: false })
    expect(r.ok && r.money.splits).toEqual([{ k: 'self', s: 500 }, { k: 'a', s: 1500 }])
  })
  it('touching the split uses the new split; mismatching custom amounts are rejected with a readable message', () => {
    const m: Money = { localMinor: 1000, currency: 'KRW', rateMicro: 1e6, homeMinor: 1000, shared: true, payer: 'self', splits: [{ k: 'self', s: 500 }, { k: 'a', s: 500 }] }
    const ok = buildMoney(f({ cur: 'KRW', local: '1000', shared: true, picked: ['self', 'a'], mode: 'custom', custom: { self: '300', a: '700' } }), m, { money: false, split: true })
    expect(ok.ok && ok.money.splits).toEqual([{ k: 'self', s: 300 }, { k: 'a', s: 700 }])
    const bad = buildMoney(f({ cur: 'KRW', local: '1000', shared: true, picked: ['self', 'a'], mode: 'custom', custom: { self: '300', a: '600' } }), m, { money: false, split: true })
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('100원 부족') })
  })
})

describe('buildMoney: new expenses', () => {
  it('personal / shared equal / errors', () => {
    expect(buildMoney(f({ cur: 'KRW', local: '5000' }), null, clean)).toMatchObject({ ok: true, money: { homeMinor: 5000, shared: false, payer: 'self', splits: [] } })
    const s = buildMoney(f({ cur: 'KRW', local: '10000', shared: true, picked: ['self', 'a', 'b'] }), null, clean)
    expect(s.ok && s.money.splits.reduce((a, x) => a + x.s, 0)).toBe(10000)
    expect(buildMoney(f({ local: '' }), null, clean)).toMatchObject({ ok: false, error: '금액을 입력하세요.' })
    expect(buildMoney(f({ rate: '' }), null, clean)).toMatchObject({ ok: false, error: expect.stringContaining('환율') })
    expect(buildMoney(f({ cur: 'KRW', local: '100', shared: true, picked: [] }), null, clean)).toMatchObject({ ok: false, error: expect.stringContaining('참여자') })
  })
  it('a foreign currency never silently defaults to a rate of 1', () => {
    expect(defaultRateText('KRW')).toBe('1')
    expect(defaultRateText('JPY')).toBe('')                      // 비워 두어 직접 입력하게 한다
    expect(defaultRateText('JPY', 9_100_000)).toBe('9.1')
    expect(buildMoney(f({ cur: 'JPY', local: '1500', rate: defaultRateText('JPY') }), null, clean)).toMatchObject({ ok: false })
  })
})
