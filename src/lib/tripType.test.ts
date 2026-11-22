import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { TripMateDB } from '../db/local'
import { desiredForTrip } from '../db/reminders'
import { createTrip } from '../db/trips'
import type { ChecklistItem, ItineraryItem } from '../db/types'
import { computeGuide } from './guide'
import { CHECKLIST_ABROAD, CHECKLIST_DOMESTIC, FOREIGN_DEFAULT, isDomestic } from './tripType'

describe('isDomestic: only "Korean time zone AND won" is a domestic trip', () => {
  it('classifies', () => {
    expect(isDomestic({ timeZone: 'Asia/Seoul', localCurrency: 'KRW' })).toBe(true)
    expect(isDomestic({})).toBe(true)                                               // 값이 없으면 기본(국내)
    expect(isDomestic({ timeZone: 'Asia/Tokyo', localCurrency: 'JPY' })).toBe(false)
    expect(isDomestic({ timeZone: 'Asia/Tokyo', localCurrency: 'KRW' })).toBe(false)  // 하나라도 다르면 해외
    expect(isDomestic({ timeZone: 'Asia/Seoul', localCurrency: 'USD' })).toBe(false)
    expect(isDomestic(FOREIGN_DEFAULT)).toBe(false)                                 // 해외로 바꿀 때 기본값은 해외로 분류된다
  })
})

let db: TripMateDB
let n = 0
beforeEach(() => { db = new TripMateDB(`type-${n++}`) })
const mk = (o: Record<string, unknown> = {}) => ({ name: '여행', country: '', city: '', startDate: '2030-05-10', endDate: '2030-05-12', ...o })

describe('new trips get the checklist that fits', () => {
  it('domestic: no passport / exchange / roaming', async () => {
    const t = await createTrip(mk({ timeZone: 'Asia/Seoul', localCurrency: 'KRW' }), db)
    const titles = (await db.checklistItems.where('tripId').equals(t.id).sortBy('sortOrder')).map((c) => c.title)
    expect(titles).toEqual(CHECKLIST_DOMESTIC)
    expect(titles.join()).not.toMatch(/여권|환전|로밍/)
  })
  it('abroad: unchanged from before', async () => {
    const t = await createTrip(mk({ timeZone: 'Asia/Tokyo', localCurrency: 'JPY' }), db)
    const titles = (await db.checklistItems.where('tripId').equals(t.id).sortBy('sortOrder')).map((c) => c.title)
    expect(titles).toEqual(CHECKLIST_ABROAD)
    expect(titles).toEqual(['여권 확인', '항공권/예약 확인', '환전', '로밍/유심', '충전기/어댑터', '여행자 보험'])
  })
  it('the checklist is queued for sync either way', async () => {
    const t = await createTrip(mk(), db)
    const rows = await db.checklistItems.where('tripId').equals(t.id).toArray()
    const q = await db.outbox.where('table').equals('checklist_items').toArray()
    expect(q).toHaveLength(rows.length)
  })
})

describe('the evening-before reminder', () => {
  it('mentions the passport only for trips abroad', async () => {
    const dom = await createTrip(mk({ startDate: '2099-05-10', endDate: '2099-05-12' }), db)
    const abr = await createTrip(mk({ startDate: '2099-05-10', endDate: '2099-05-12', timeZone: 'Asia/Tokyo', localCurrency: 'JPY' }), db)
    expect(desiredForTrip(dom, 0)[0].body).not.toMatch(/여권/)
    expect(desiredForTrip(abr, 0)[0].body).toMatch(/여권/)
  })
})

describe('trip stages', () => {
  const meta = { version: 0, updatedAt: 0, deletedAt: null, syncState: 'synced' as const }
  const item = (o: Partial<ItineraryItem>): ItineraryItem => ({ id: Math.random().toString(), tripId: 't', ...meta, dayNumber: 1, kind: 'sight', title: 'x', startTime: null, endTime: null, completed: false, sortOrder: 0, ...o } as ItineraryItem)
  const check: ChecklistItem[] = [{ id: 'c', tripId: 't', ...meta, title: '신분증', done: false, sortOrder: 0 } as ChecklistItem]

  it('abroad keeps all 9 stages and the word 귀국', () => {
    const g = computeGuide([], check, 3)
    expect(g).toHaveLength(9)
    expect(g.at(-1)?.label).toBe('귀국')
  })
  it('domestic hides airport/flight stages when there is no such item, and says 귀가', () => {
    const g = computeGuide([item({ kind: 'sight' })], check, 3, { domestic: true })
    expect(g.map((s) => s.key)).toEqual(['prep', 'arrive', 'checkin', 'tour', 'checkout', 'return'])
    expect(g.at(-1)?.label).toBe('귀가')
  })
  it('domestic keeps the flight stages when the trip actually has a flight (e.g. to Jeju)', () => {
    const g = computeGuide([item({ kind: 'flight', dayNumber: 1 }), item({ kind: 'flight', dayNumber: 3 })], check, 3, { domestic: true })
    expect(g.map((s) => s.key)).toContain('flight_out')
    expect(g.find((s) => s.key === 'return')?.label).toBe('귀가')
    expect(g.find((s) => s.key === 'return')?.total).toBe(1)
  })
})
