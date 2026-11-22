import { describe, expect, it } from 'vitest'
import type { Money } from '../db/types'
import { balances, minTransfers, type Transfer } from './settle'
import { hashId, rescaleSplits, splitEqual, validateSplits } from './split'

const money = (home: number, payer: string, splits: [string, number][]): { money: Money } => ({ money: { localMinor: home, currency: 'KRW', rateMicro: 1_000_000, homeMinor: home, shared: true, payer, splits: splits.map(([k, s]) => ({ k, s })) } })

/** 송금을 적용하면 모두 0원이 되는지 */
const applies = (bal: Record<string, number>, ts: Transfer[]) => {
  const b = { ...bal }
  for (const t of ts) { b[t.from] = (b[t.from] ?? 0) + t.amount; b[t.to] = (b[t.to] ?? 0) - t.amount }
  return Object.values(b).every((v) => v === 0)
}

/** 독립적인 정답: 합이 0인 묶음으로 나누는 모든 경우(집합 분할)를 직접 따져서 송금 횟수의 최솟값을 구한다 */
function bruteMin(values: number[]): number {
  const n = values.length
  let best = n - 1
  const rec = (i: number, groups: number[][]) => {
    if (i === n) { if (groups.every((g) => g.reduce((a, b) => a + b, 0) === 0)) best = Math.min(best, n - groups.length); return }
    for (const g of groups) { g.push(values[i]); rec(i + 1, groups); g.pop() }
    groups.push([values[i]]); rec(i + 1, groups); groups.pop()
  }
  rec(0, [])
  return best
}

describe('balances', () => {
  it('payer is owed, participants owe, personal expenses are ignored', () => {
    const b = balances([
      money(30000, 'self', [['self', 10000], ['b', 10000], ['c', 10000]]),
      money(9000, 'b', [['self', 3000], ['b', 3000], ['c', 3000]]),
      { money: { localMinor: 5000, currency: 'KRW', rateMicro: 1e6, homeMinor: 5000, shared: false, payer: 'self', splits: [] } },
    ])
    expect(b).toEqual({ self: 20000 - 3000, b: -10000 + 9000 - 3000, c: -13000 })
    expect(Object.values(b).reduce((a, v) => a + v, 0)).toBe(0)
  })
  it('people whose balance nets to zero are dropped', () => {
    expect(balances([money(2000, 'a', [['a', 1000], ['b', 1000]]), money(2000, 'b', [['a', 1000], ['b', 1000]])])).toEqual({})
  })
})

describe('minTransfers', () => {
  it('classic cases', () => {
    expect(minTransfers({})).toEqual([])
    expect(minTransfers({ a: 100, b: -100 })).toEqual([{ from: 'b', to: 'a', amount: 100 }])
    // 합이 0인 묶음이 둘 → 2건 (한 묶음으로 보면 3건이 된다)
    const t = minTransfers({ a: 10, b: -10, c: 20, d: -20 })
    expect(t).toHaveLength(2); expect(applies({ a: 10, b: -10, c: 20, d: -20 }, t)).toBe(true)
    // 한 명이 모두에게서 받는 경우
    expect(minTransfers({ a: 300, b: -100, c: -100, d: -100 })).toHaveLength(3)
  })
  it('rejects balances that do not sum to zero', () => { expect(() => minTransfers({ a: 10, b: -5 })).toThrow() })

  it('matches an independent brute-force optimum, conserves money and never exceeds n-1 transfers (random)', () => {
    let seed = 99
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let t = 0; t < 400; t++) {
      const n = 2 + Math.floor(rnd() * 6)
      const vals = Array.from({ length: n - 1 }, () => Math.round((rnd() - 0.5) * 20) * (rnd() < 0.5 ? 1 : 100))
      vals.push(-vals.reduce((a, b) => a + b, 0))
      const bal = Object.fromEntries(vals.map((v, i) => [`p${i}`, v]))
      const ts = minTransfers(bal)
      expect(applies(bal, ts)).toBe(true)
      expect(ts.every((x) => x.amount > 0 && Number.isInteger(x.amount) && x.from !== x.to)).toBe(true)
      const nonzero = vals.filter((v) => v !== 0)
      expect(ts.length).toBe(nonzero.length === 0 ? 0 : bruteMin(nonzero))
      expect(ts.length).toBeLessThanOrEqual(Math.max(0, nonzero.length - 1))
    }
  })
  it('handles 16 people exactly and 30 people with the greedy fallback, both settling to zero', () => {
    for (const n of [16, 30]) {
      const vals = Array.from({ length: n - 1 }, (_, i) => ((i * 7919) % 2000) - 1000)
      vals.push(-vals.reduce((a, b) => a + b, 0))
      const bal = Object.fromEntries(vals.map((v, i) => [`p${String(i).padStart(2, '0')}`, v]))
      const ts = minTransfers(bal)
      expect(applies(bal, ts)).toBe(true)
      expect(ts.length).toBeLessThanOrEqual(n - 1)
    }
  })
  it('is deterministic', () => {
    const bal = { a: 500, b: -200, c: -300, d: 70, e: -70 }
    expect(minTransfers(bal)).toEqual(minTransfers({ ...bal }))
  })
})

describe('splitEqual / rescale / validate', () => {
  it('always sums exactly and differs by at most 1 won between people (random)', () => {
    let seed = 5
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 500; i++) {
      const total = Math.floor(rnd() * 2_000_000), n = 1 + Math.floor(rnd() * 9)
      const keys = Array.from({ length: n }, (_, j) => `k${j}`)
      const s = splitEqual(total, keys, 'exp' + i)
      expect(s.reduce((a, x) => a + x.s, 0)).toBe(total)
      const v = s.map((x) => x.s); expect(Math.max(...v) - Math.min(...v)).toBeLessThanOrEqual(1)
      expect(validateSplits(total, s)).toBeNull()
    }
  })
  it('the extra won is spread across people instead of always going to the same person', () => {
    const got = new Map<string, number>()
    for (let i = 0; i < 300; i++) for (const x of splitEqual(100, ['a', 'b', 'c'], `e${i}`)) if (x.s === 34) got.set(x.k, (got.get(x.k) ?? 0) + 1)
    expect([...got.keys()].sort()).toEqual(['a', 'b', 'c'])
    for (const v of got.values()) expect(v).toBeGreaterThan(60)
    expect(splitEqual(100, ['a', 'b', 'c'], 'same')).toEqual(splitEqual(100, ['a', 'b', 'c'], 'same'))   // 같은 id 는 항상 같은 결과
    expect(hashId('x')).toBe(hashId('x'))
  })
  it('validation messages, duplicates and bad numbers', () => {
    expect(validateSplits(100, [])).toMatch(/참여자/)
    expect(validateSplits(100, [{ k: 'a', s: 50 }, { k: 'a', s: 50 }])).toMatch(/두 번/)
    expect(validateSplits(100, [{ k: 'a', s: -1 }, { k: 'b', s: 101 }])).toMatch(/올바르지/)
    expect(validateSplits(100, [{ k: 'a', s: 50.5 }, { k: 'b', s: 49.5 }])).toMatch(/올바르지/)
    expect(validateSplits(100, [{ k: 'a', s: 60 }, { k: 'b', s: 50 }])).toMatch(/10원 초과/)
    expect(validateSplits(100, [{ k: 'a', s: 60 }, { k: 'b', s: 30 }])).toMatch(/10원 부족/)
    expect(() => splitEqual(-1, ['a'], 's')).toThrow(); expect(() => splitEqual(10, [], 's')).toThrow()
  })
  it('rescaling keeps custom proportions and the exact total, including huge amounts', () => {
    expect(rescaleSplits(1000, [{ k: 'a', s: 100 }, { k: 'b', s: 300 }], 'e')).toEqual([{ k: 'a', s: 250 }, { k: 'b', s: 750 }])
    expect(rescaleSplits(1001, [{ k: 'a', s: 1 }, { k: 'b', s: 1 }, { k: 'c', s: 1 }], 'e').reduce((a, x) => a + x.s, 0)).toBe(1001)
    expect(rescaleSplits(9_007_199_254_740_000, [{ k: 'a', s: 3 }, { k: 'b', s: 7 }], 'e').reduce((a, x) => a + x.s, 0)).toBe(9_007_199_254_740_000)
    expect(rescaleSplits(10, [{ k: 'a', s: 0 }, { k: 'b', s: 0 }], 'e').reduce((a, x) => a + x.s, 0)).toBe(10)
  })
})
