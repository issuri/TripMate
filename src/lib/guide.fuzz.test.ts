// 무작위 일정으로 가이드 계산의 불변 조건을 확인한다: 죽지 않고, 단계는 정해진 순서, "진행 중"은 최대 하나, 개수가 맞는다.
import { describe, expect, it } from 'vitest'
import type { ChecklistItem, ItemKind, ItineraryItem } from '../db/types'
import { computeGuide } from './guide'
import { suggestKind } from './kindHint'
import { zonedToUtc } from './tz'

const KINDS: ItemKind[] = ['flight', 'transit', 'lodging_in', 'lodging_out', 'sight', 'meal', 'shopping', 'airport', 'other']
const ORDER = ['prep', 'airport_out', 'flight_out', 'arrive', 'checkin', 'tour', 'checkout', 'airport_ret', 'return']
const meta = { version: 0, updatedAt: 0, syncState: 'synced' as const }

describe('computeGuide invariants on random trips', () => {
  it('holds for thousands of random itineraries, with and without a clock, domestic or not', () => {
    let seed = Number(process.env.GUIDE_FUZZ_SEED ?? 20261122)
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]
    const tz = pick(['Asia/Tokyo', 'Europe/Paris', 'America/New_York', 'Asia/Seoul', 'Pacific/Auckland'])
    const TRIALS = Number(process.env.GUIDE_FUZZ_TRIALS ?? 1500)       // 더 오래 돌리려면 GUIDE_FUZZ_TRIALS=20000 처럼 지정
    for (let trial = 0; trial < TRIALS; trial++) {
      const days = 1 + Math.floor(rnd() * 6)
      const n = Math.floor(rnd() * 14)
      const items: ItineraryItem[] = Array.from({ length: n }, (_, k) => ({
        id: `i${k}`, tripId: 't', ...meta, deletedAt: rnd() < 0.1 ? 1 : null, dayNumber: 1 + Math.floor(rnd() * days), kind: pick(KINDS), title: 'x',
        startTime: rnd() < 0.7 ? `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}` : null, endTime: null, completed: rnd() < 0.3, sortOrder: k,
      } as ItineraryItem))
      const list: ChecklistItem[] = Array.from({ length: Math.floor(rnd() * 5) }, (_, k) => ({ id: `c${k}`, tripId: 't', ...meta, deletedAt: rnd() < 0.1 ? 1 : null, title: 'c', done: rnd() < 0.5, sortOrder: k } as ChecklistItem))
      const start = '2030-05-10'
      const timed = rnd() < 0.7
      const now = zonedToUtc('2030-05-08', '00:00', tz) + Math.floor(rnd() * 12 * 86_400_000)
      const domestic = rnd() < 0.4
      const before = JSON.stringify([items, list])
      const g = computeGuide(items, list, days, { domestic, ...(timed ? { now, startDate: start, timeZone: tz } : {}) })
      expect(JSON.stringify([items, list]), '입력 데이터를 바꾸지 않는다').toBe(before)

      // 단계는 정해진 순서대로, 중복 없이
      const keys = g.map((s) => s.key)
      expect(keys.every((k, i) => i === 0 || ORDER.indexOf(k) > ORDER.indexOf(keys[i - 1])), keys.join()).toBe(true)
      expect(keys[0]).toBe('prep')
      if (!domestic) expect(keys).toHaveLength(9)
      // 진행 중은 최대 하나이고, 그 앞에 미완료 단계가 없다
      const cur = g.filter((s) => s.state === 'current')
      expect(cur.length).toBeLessThanOrEqual(1)
      if (cur[0]) for (const s of g.slice(0, g.indexOf(cur[0]))) expect(['done', 'empty'], `${s.key} before current`).toContain(s.state)
      for (const s of g) {
        expect(s.pending).toBeGreaterThanOrEqual(0)
        expect(s.passed).toBeGreaterThanOrEqual(0)
        expect(s.pending + s.passed).toBeLessThanOrEqual(s.total)
        if (s.state === 'empty') expect(s.total).toBe(0)
        if (s.state === 'done') expect(s.pending).toBe(0)
        if (s.state === 'current' || s.state === 'upcoming') expect(s.pending).toBeGreaterThan(0)
        if (!timed) expect(s.passed).toBe(0)
      }
      // 삭제된 일정은 어느 단계에도 세지 않는다. 일정 단계 합 = 살아 있는 일정 수
      const live = items.filter((i) => i.deletedAt === null).length
      expect(g.filter((s) => s.key !== 'prep').reduce((a, s) => a + s.total, 0)).toBeLessThanOrEqual(live + 0)
      // 가는 길/오는 길 항공편: 모든 항공편이 둘 중 하나에 정확히 한 번 들어간다
      const flights = items.filter((i) => i.deletedAt === null && i.kind === 'flight').length
      const counted = g.filter((s) => s.key === 'flight_out' || s.key === 'return').reduce((a, s) => a + s.total, 0)
      expect(counted).toBe(flights)
    }
  }, 60_000)

  it('a clock can only move the guide forward: more time passed never makes a step less done', () => {
    const items: ItineraryItem[] = [
      { id: 'a', kind: 'airport', dayNumber: 1, startTime: '08:00' }, { id: 'b', kind: 'flight', dayNumber: 1, startTime: '11:00' },
      { id: 'c', kind: 'lodging_in', dayNumber: 1, startTime: '16:00' }, { id: 'd', kind: 'sight', dayNumber: 2, startTime: '10:00' },
      { id: 'e', kind: 'flight', dayNumber: 3, startTime: '15:00' },
    ].map((x) => ({ tripId: 't', ...meta, deletedAt: null, title: 'x', endTime: null, completed: false, sortOrder: 0, ...x }) as ItineraryItem)
    const rank = { empty: 0, upcoming: 1, current: 1, done: 2 } as const
    let prev: number[] | null = null
    for (let h = 0; h <= 96; h += 3) {
      const g = computeGuide(items, [], 3, { now: zonedToUtc('2030-05-09', '12:00', 'Asia/Tokyo') + h * 3_600_000, startDate: '2030-05-10', timeZone: 'Asia/Tokyo' })
      const cur = g.map((s) => rank[s.state])
      if (prev) cur.forEach((v, i) => expect(v, `${g[i].key} at +${h}h`).toBeGreaterThanOrEqual(prev![i]))
      prev = cur
    }
  })
})

describe('suggestKind', () => {
  it('never throws and only returns real kinds, whatever the text', () => {
    const real = new Set<string>(KINDS)
    const samples = ['', ' ', '\n', '😀', 'a'.repeat(5000), '(((', '[a-z', '\\', '체크', '체크 인 아웃', '공항호텔항공식사', '%$#@!', '日本語のテスト', 'null', 'undefined']
    for (const s of samples) { const k = suggestKind(s); expect(k === null || real.has(k), s.slice(0, 10)).toBe(true) }
  })
  it('is fast on long text (no catastrophic backtracking)', () => {
    const t = Date.now()
    suggestKind('체크 '.repeat(20000) + '인')
    suggestKind('a'.repeat(100000))
    expect(Date.now() - t).toBeLessThan(1500)
  })
})
