import { describe, expect, it } from 'vitest'
import type { ChecklistItem, ItemKind, ItineraryItem } from '../db/types'
import { computeGuide } from './guide'
import { suggestKind } from './kindHint'
import { zonedToUtc } from './tz'

const meta = { version: 0, updatedAt: 0, deletedAt: null, syncState: 'synced' as const }
let n = 0
const item = (kind: ItemKind, dayNumber: number, startTime: string | null = null, o: Partial<ItineraryItem> = {}): ItineraryItem =>
  ({ id: `i${n++}`, tripId: 't', ...meta, dayNumber, kind, title: kind, startTime, endTime: null, completed: false, sortOrder: n, ...o } as ItineraryItem)
const checklist = (done: boolean): ChecklistItem[] => [{ id: 'c', tripId: 't', ...meta, title: '여권', done, sortOrder: 0 } as ChecklistItem]
const stage = (g: ReturnType<typeof computeGuide>, key: string) => g.find((s) => s.key === key)!
const totals = (g: ReturnType<typeof computeGuide>) => Object.fromEntries(g.map((s) => [s.key, s.total]))

describe('outbound / return flights are told apart without relying on the last day', () => {
  it('2 nights 3 days: day-1 flight goes out, day-3 flight is the return', () => {
    const g = computeGuide([item('airport', 1, '08:00'), item('flight', 1, '11:00'), item('airport', 3, '12:00'), item('flight', 3, '15:00')], checklist(true), 3)
    expect(totals(g)).toMatchObject({ airport_out: 1, flight_out: 1, airport_ret: 1, return: 1 })
  })
  it('a late-night return flight put on day 2 is still the return (it is not the last day)', () => {
    const g = computeGuide([item('airport', 1, '08:00'), item('flight', 1, '11:00'), item('airport', 2, '21:00'), item('flight', 2, '23:30')], checklist(true), 3)
    expect(totals(g)).toMatchObject({ airport_out: 1, flight_out: 1, airport_ret: 1, return: 1 })
  })
  it('a connecting trip with two legs each way is split between going and coming back', () => {
    const g = computeGuide([item('flight', 1, '08:00'), item('flight', 1, '14:00'), item('flight', 4, '10:00'), item('flight', 4, '16:00')], checklist(true), 4)
    expect(totals(g)).toMatchObject({ flight_out: 2, return: 2 })
  })
  it('a day trip with two flights: first goes out, second comes back', () => {
    const g = computeGuide([item('flight', 1, '08:00'), item('flight', 1, '20:00')], checklist(true), 1)
    expect(totals(g)).toMatchObject({ flight_out: 1, return: 1 })
  })
  it('a single flight keeps the old rule: on the last day of a multi-day trip it is the return, otherwise it goes out', () => {
    expect(totals(computeGuide([item('flight', 3, '15:00')], checklist(true), 3))).toMatchObject({ flight_out: 0, return: 1 })
    expect(totals(computeGuide([item('flight', 1, '11:00')], checklist(true), 3))).toMatchObject({ flight_out: 1, return: 0 })
    expect(totals(computeGuide([item('flight', 1, '11:00')], checklist(true), 1))).toMatchObject({ flight_out: 1, return: 0 })
  })
  it('flights without a time still work (they are placed at the start of their day)', () => {
    const g = computeGuide([item('flight', 1), item('flight', 3)], checklist(true), 3)
    expect(totals(g)).toMatchObject({ flight_out: 1, return: 1 })
  })
  it('deleted items are ignored', () => {
    const g = computeGuide([item('flight', 1, '11:00'), item('flight', 3, '15:00', { deletedAt: 5 }), item('flight', 2, '10:00', { deletedAt: 5 })], checklist(true), 3)
    expect(totals(g)).toMatchObject({ flight_out: 1, return: 0 })
  })
})

describe('time-aware progress (data is never changed)', () => {
  const start = '2030-05-10', tz = 'Asia/Tokyo'
  const at = (date: string, time: string) => zonedToUtc(date, time, tz)
  const items = () => [item('airport', 1, '08:00'), item('flight', 1, '11:00'), item('lodging_in', 1, '16:00'), item('sight', 2, '10:00'), item('lodging_out', 3, '11:00'), item('flight', 3, '15:00')]
  const opts = (now: number) => ({ now, startDate: start, timeZone: tz })

  it('without a clock nothing is treated as past', () => {
    const g = computeGuide(items(), checklist(false), 3)
    expect(g.every((s) => s.passed === 0)).toBe(true)
    expect(stage(g, 'prep').state).toBe('current')
  })
  it('before the trip starts: nothing is past, preparation is the current step', () => {
    const g = computeGuide(items(), checklist(false), 3, opts(at('2030-05-09', '20:00')))
    expect(g.every((s) => s.passed === 0)).toBe(true)
    expect(stage(g, 'prep').state).toBe('current')
  })
  it('once the trip has started, unfinished preparation no longer blocks the guide', () => {
    const g = computeGuide(items(), checklist(false), 3, opts(at('2030-05-10', '07:00')))
    expect(stage(g, 'prep')).toMatchObject({ state: 'done', passed: 1 })
    expect(stage(g, 'airport_out').state).toBe('current')
  })
  it('items whose time has passed count as passed even if never ticked, so the guide moves on by itself', () => {
    const g = computeGuide(items(), checklist(true), 3, opts(at('2030-05-10', '12:00')))   // 공항(08:00), 비행(11:00) 지남
    expect(stage(g, 'airport_out')).toMatchObject({ state: 'done', passed: 1 })
    expect(stage(g, 'flight_out')).toMatchObject({ state: 'done', passed: 1 })
    expect(stage(g, 'checkin').state).toBe('current')                                      // 16:00 체크인이 다음
  })
  it('an item ticked by the user is done, not "passed"', () => {
    const g = computeGuide([item('flight', 1, '11:00', { completed: true })], checklist(true), 3, opts(at('2030-05-10', '12:00')))
    expect(stage(g, 'flight_out')).toMatchObject({ state: 'done', passed: 0 })
  })
  it('an item without a time is past only after its day is over', () => {
    const list = [item('sight', 2)]
    expect(stage(computeGuide(list, checklist(true), 3, opts(at('2030-05-11', '15:00'))), 'tour').state).toBe('current')
    expect(stage(computeGuide(list, checklist(true), 3, opts(at('2030-05-12', '00:30'))), 'tour').state).toBe('done')
  })
  it('after the trip every stage is done', () => {
    const g = computeGuide(items(), checklist(false), 3, opts(at('2030-05-13', '09:00')))
    expect(g.filter((s) => s.state !== 'empty').every((s) => s.state === 'done')).toBe(true)
  })
  it('uses the trip time zone, not the viewer time zone', () => {
    const noonTokyo = at('2030-05-10', '12:00')
    const g = computeGuide([item('flight', 1, '11:00')], checklist(true), 3, { now: noonTokyo, startDate: start, timeZone: tz })
    expect(stage(g, 'flight_out').state).toBe('done')
    const g2 = computeGuide([item('flight', 1, '11:00')], checklist(true), 3, { now: noonTokyo, startDate: start, timeZone: 'America/New_York' })
    expect(stage(g2, 'flight_out').state).toBe('current')    // 같은 순간이라도 뉴욕의 5/10 11:00 은 아직 오지 않았다
  })
  it('a broken time zone does not crash the guide', () => {
    expect(() => computeGuide(items(), checklist(true), 3, { now: Date.now(), startDate: start, timeZone: 'Nowhere/Land' })).not.toThrow()
  })
})

describe('suggesting the kind from the title', () => {
  const cases: [string, ItemKind | null][] = [
    ['인천공항 이동', 'airport'], ['공항 도착', 'airport'], ['항공편 탑승', 'flight'], ['KE703 비행기', 'flight'], ['귀국편', 'flight'], ['출국', 'flight'],
    ['호텔 체크인', 'lodging_in'], ['숙소 도착', 'lodging_in'], ['체크아웃', 'lodging_out'], ['호텔 체크아웃', 'lodging_out'], ['Check out', 'lodging_out'],
    ['점심 식사', 'meal'], ['이치란 라멘', 'meal'], ['카페', 'meal'], ['저녁', 'meal'],
    ['면세점 쇼핑', 'shopping'], ['돈키호테', 'shopping'], ['시장 구경', 'shopping'],
    ['지하철 이동', 'transit'], ['KTX 출발', 'transit'], ['렌터카 픽업', 'transit'],
    ['시부야 관광', 'sight'], ['박물관', 'sight'], ['온천 체험', 'sight'],
    ['', null], ['a', null], ['시부야', null], ['메모', null],
  ]
  for (const [title, kind] of cases) it(`"${title}" → ${kind}`, () => expect(suggestKind(title)).toBe(kind))
  it('the lodging words win over airport words, and flight words over meal words', () => {
    expect(suggestKind('공항 근처 호텔 체크인')).toBe('lodging_in')
    expect(suggestKind('항공편 기내식')).toBe('flight')
  })
})
