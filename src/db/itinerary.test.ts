import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { computeGuide, gapMinutes, nextItem } from '../lib/guide'
import { addChecklist, addItem, byOrder, deleteItem, listItems, moveItem, setCompleted, updateItem, updateTrip } from './itinerary'

import { TripMateDB } from './local'
import { createTrip } from './trips'

let db: TripMateDB
let tripId: string
beforeEach(async () => {
  db = new TripMateDB('t-' + Math.random()); await db.open()
  tripId = (await createTrip({ name: 'T', country: 'JP', city: 'Tokyo', startDate: '2026-12-01', endDate: '2026-12-03' }, db)).id
})
const order = async (day: number) => (await listItems(tripId, db)).filter((i) => i.dayNumber === day).sort(byOrder).map((i) => i.title)

describe('itinerary', () => {
  it('inserts by start time, appends items without time', async () => {
    await addItem(tripId, { dayNumber: 1, kind: 'sight', title: 'B', startTime: '14:00' }, db)
    await addItem(tripId, { dayNumber: 1, kind: 'airport', title: 'A', startTime: '09:00' }, db)
    await addItem(tripId, { dayNumber: 1, kind: 'meal', title: 'C', startTime: '18:00' }, db)
    await addItem(tripId, { dayNumber: 1, kind: 'other', title: 'D' }, db)
    expect(await order(1)).toEqual(['A', 'B', 'C', 'D'])
  })
  it('reorders with single-row change', async () => {
    const a = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: 'A' }, db)
    await addItem(tripId, { dayNumber: 1, kind: 'sight', title: 'B' }, db)
    const c = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: 'C' }, db)
    await db.outbox.clear()
    await moveItem(c.id, -1, db)
    expect(await order(1)).toEqual(['A', 'C', 'B'])
    expect(await db.outbox.count()).toBe(1)
    await moveItem(c.id, -1, db)
    expect(await order(1)).toEqual(['C', 'A', 'B'])
    await moveItem(a.id, 1, db)
    expect(await order(1)).toEqual(['C', 'B', 'A'])
    await moveItem(c.id, -1, db) // 맨 앞에서 위로: 변화 없음
    expect(await order(1)).toEqual(['C', 'B', 'A'])
  })
  it('validates time and edits/deletes', async () => {
    // 자정을 넘기는 일정(22:00~01:00)은 허용하고, 이어지는 일정과의 간격도 다음 날 기준으로 계산한다
    const night = await addItem(tripId, { dayNumber: 1, kind: 'flight', title: '야간 비행', startTime: '22:00', endTime: '01:00' }, db)
    const after = await addItem(tripId, { dayNumber: 1, kind: 'transit', title: '공항철도', startTime: '02:30' }, db)
    expect(gapMinutes(night, after)).toBe(90)
    await deleteItem(night.id, db); await deleteItem(after.id, db)
    const a = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: 'A' }, db)
    await updateItem(a.id, { title: 'A2', dayNumber: 2 }, db)
    expect(await order(2)).toEqual(['A2'])
    await setCompleted(a.id, true, db)
    expect((await db.itineraryItems.get(a.id))?.completed).toBe(true)
    await deleteItem(a.id, db)
    expect(await listItems(tripId, db)).toHaveLength(0)
    await expect(updateItem(a.id, { title: 'zombie' }, db)).rejects.toThrow() // 삭제된 일정은 되살아나지 않음
  })
  it('rejects NaN/negative/huge travel minutes and malformed times', async () => {
    for (const bad of [NaN, -5, 2.5, 99999]) {
      await expect(addItem(tripId, { dayNumber: 1, kind: 'sight', title: 'x', travelMinutes: bad }, db)).rejects.toThrow(/이동 시간/)
    }
    await expect(addItem(tripId, { dayNumber: 1, kind: 'sight', title: 'x', startTime: '25:99' }, db)).rejects.toThrow(/시간 형식/)
    expect(await listItems(tripId, db)).toHaveLength(0)
  })
  it('updateTrip ignores non-editable fields so stale form data cannot clobber other changes', async () => {
    await updateTrip(tripId, { shoppingBudgetMinor: 5000 }, db)
    const stale = { name: 'Renamed', id: 'evil', version: 99, shoppingBudgetMinor: undefined, ownerId: 'x' } as never
    await updateTrip(tripId, stale, db)
    const t = (await db.trips.get(tripId))!
    expect(t.name).toBe('Renamed')
    expect(t.shoppingBudgetMinor).toBe(5000)
    expect(t.id).toBe(tripId)
    expect(t.version).not.toBe(99)
    expect(t.ownerId).toBe('local')
  })
  it('updateTrip records only fields that actually changed and skips no-op saves', async () => {
    await db.outbox.clear()
    await updateTrip(tripId, { name: 'T', city: 'Tokyo', purpose: 'fun' }, db) // name/city는 그대로, purpose만 변경
    const e = await db.outbox.toArray()
    expect(e).toHaveLength(1)
    expect(e[0].changedFields).toEqual(['purpose'])
    await db.outbox.clear()
    await updateTrip(tripId, { name: 'T', city: 'Tokyo', purpose: 'fun' }, db)
    expect(await db.outbox.count()).toBe(0)
  })
  it('shrinking trip moves orphan items to the last day instead of losing them', async () => {
    await addItem(tripId, { dayNumber: 3, kind: 'sight', title: 'last' }, db)
    await updateTrip(tripId, { endDate: '2026-12-02' }, db)
    expect((await listItems(tripId, db))[0].dayNumber).toBe(2)
  })
})

describe('guide', () => {
  it('computes stages, current stage and next item', async () => {
    const x = await addItem(tripId, { dayNumber: 1, kind: 'airport', title: '공항', startTime: '09:00' }, db)
    await addItem(tripId, { dayNumber: 1, kind: 'flight', title: '비행', startTime: '11:00' }, db)
    await addItem(tripId, { dayNumber: 3, kind: 'flight', title: '귀국편', startTime: '15:00' }, db)
    await addChecklist(tripId, '추가', db)
    const check = await db.checklistItems.toArray()
    await Promise.all(check.map((c) => db.checklistItems.update(c.id, { done: true })))
    await setCompleted(x.id, true, db)
    const items = await listItems(tripId, db)
    const g = computeGuide(items, await db.checklistItems.toArray(), 3)
    const by = Object.fromEntries(g.map((s) => [s.key, s.state]))
    expect(by).toMatchObject({ prep: 'done', airport_out: 'done', flight_out: 'current', return: 'upcoming', checkin: 'empty' })
    expect(nextItem(items)?.title).toBe('비행')
  })
  it('gap minutes', async () => {
    const a = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: 'a', startTime: '10:00', endTime: '11:30' }, db)
    const b = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: 'b', startTime: '12:15' }, db)
    expect(gapMinutes(a, b)).toBe(45)
  })
})
