import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { addItem, setCompleted, updateItem } from './itinerary'
import { TripMateDB } from './local'
import { reconcileTrip, remindersEnabled, setRemindersEnabled, upcomingReminders } from './reminders'
import { createTrip, deleteTrip } from './trips'

let db: TripMateDB
let n = 0
beforeEach(() => { db = new TripMateDB(`prefs-${n++}`) })

const newTrip = (name = '도쿄') => createTrip({ name, country: '일본', city: '도쿄', startDate: '2099-05-10', endDate: '2099-05-12', timeZone: 'Asia/Tokyo', localCurrency: 'JPY' }, db)
const timed = (tripId: string, title: string, startTime = '10:00') => addItem(tripId, { dayNumber: 2, kind: 'sight', title, startTime, reminderEnabled: true, reminderMinutesBefore: 30 }, db)
const count = async (tripId: string) => (await db.reminders.where('tripId').equals(tripId).toArray()).length

describe('turning reminders off for a trip on this device', () => {
  it('is on by default, and a new trip gets its evening-before reminder plus one per timed item', async () => {
    const t = await newTrip()
    await timed(t.id, '시부야')
    expect(await remindersEnabled(t.id, db)).toBe(true)
    expect(await count(t.id)).toBe(2)
  })

  it('off: every scheduled reminder of that trip is cancelled', async () => {
    const t = await newTrip()
    await timed(t.id, '시부야'); await timed(t.id, '아사쿠사', '14:00')
    expect(await count(t.id)).toBeGreaterThanOrEqual(3)
    await setRemindersEnabled(t.id, false, db)
    expect(await remindersEnabled(t.id, db)).toBe(false)
    expect(await count(t.id)).toBe(0)
    expect(await upcomingReminders(t.id, db)).toEqual([])
  })

  it('off: adding, changing and completing items creates nothing, and the items themselves keep their own setting', async () => {
    const t = await newTrip()
    await setRemindersEnabled(t.id, false, db)
    const it = await timed(t.id, '시부야')
    await updateItem(it.id, { startTime: '11:00' }, db)
    await setCompleted(it.id, false, db)
    await reconcileTrip(t.id, db)
    expect(await count(t.id)).toBe(0)
    expect((await db.itineraryItems.get(it.id))?.reminderEnabled).toBe(true)     // 일정별 설정은 건드리지 않는다
  })

  it('on again: reminders come back for the current items, with no duplicates', async () => {
    const t = await newTrip()
    await timed(t.id, '시부야')
    await setRemindersEnabled(t.id, false, db)
    await timed(t.id, '아사쿠사', '14:00')
    await setRemindersEnabled(t.id, true, db)
    expect(await count(t.id)).toBe(3)                    // 출발 전날 + 일정 2개
    await setRemindersEnabled(t.id, true, db)
    await reconcileTrip(t.id, db)
    expect(await count(t.id)).toBe(3)
  })

  it('only affects that trip', async () => {
    const a = await newTrip('A'), b = await newTrip('B')
    await timed(a.id, 'a'); await timed(b.id, 'b')
    const before = await count(b.id)
    await setRemindersEnabled(a.id, false, db)
    expect(await count(a.id)).toBe(0)
    expect(await count(b.id)).toBe(before)
    expect(await remindersEnabled(b.id, db)).toBe(true)
  })

  it('turning off twice, or on when already on, is harmless', async () => {
    const t = await newTrip()
    await setRemindersEnabled(t.id, true, db)
    await setRemindersEnabled(t.id, false, db)
    await setRemindersEnabled(t.id, false, db)
    expect(await db.remindersOff.count()).toBe(1)
    await setRemindersEnabled(t.id, true, db)
    expect(await db.remindersOff.count()).toBe(0)
  })

  it('deleting a trip also forgets the setting', async () => {
    const t = await newTrip()
    await setRemindersEnabled(t.id, false, db)
    await deleteTrip(t.id, db)
    expect(await db.remindersOff.count()).toBe(0)
  })

  it('the setting is not synced: it never enters the upload queue', async () => {
    const t = await newTrip()
    const before = await db.outbox.count()
    await setRemindersEnabled(t.id, false, db)
    await setRemindersEnabled(t.id, true, db)
    expect(await db.outbox.count()).toBe(before)
  })
})
