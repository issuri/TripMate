import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { zonedToUtc } from '../lib/tz'
import { addItem, deleteItem, setCompleted, updateItem, updateTrip } from './itinerary'
import { TripMateDB } from './local'
import { claimDue, desiredForItem, GRACE_MS, reconcileTrip, upcomingReminders } from './reminders'
import { createTrip, deleteTrip } from './trips'

// 도쿄 여행: 2030-05-10 ~ 2030-05-12 (현재 시각보다 충분히 미래)
const NOW = zonedToUtc('2030-05-01', '12:00', 'Asia/Seoul')
let db: TripMateDB
let tripId: string
beforeEach(async () => {
  db = new TripMateDB('r-' + Math.random()); await db.open()
  tripId = (await createTrip({ name: '도쿄', country: '일본', city: '도쿄', startDate: '2030-05-10', endDate: '2030-05-12', timeZone: 'Asia/Tokyo' }, db)).id
})
const all = () => db.reminders.where('tripId').equals(tripId).sortBy('fireAt')

describe('timezone', () => {
  it('converts destination wall-clock time to UTC', () => {
    expect(zonedToUtc('2030-05-10', '09:00', 'Asia/Tokyo')).toBe(Date.UTC(2030, 4, 10, 0, 0))
    expect(zonedToUtc('2030-05-10', '09:00', 'Asia/Seoul')).toBe(Date.UTC(2030, 4, 10, 0, 0))
    expect(zonedToUtc('2030-05-10', '09:00', 'Europe/Paris')).toBe(Date.UTC(2030, 4, 10, 7, 0)) // 여름시간 UTC+2
    expect(zonedToUtc('2030-01-10', '09:00', 'Europe/Paris')).toBe(Date.UTC(2030, 0, 10, 8, 0)) // 겨울 UTC+1
    expect(zonedToUtc('2030-03-10', '12:00', 'America/New_York')).toBe(Date.UTC(2030, 2, 10, 16, 0)) // 서머타임 시작 직후 UTC-4
    expect(zonedToUtc('2030-03-09', '12:00', 'America/New_York')).toBe(Date.UTC(2030, 2, 9, 17, 0)) // 전날 UTC-5
  })
})

describe('reminder generation', () => {
  it('creates start + leave reminders in destination time, and a trip-eve reminder in Korean time', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'flight', title: '항공편', startTime: '10:00', travelMinutes: 45, reminderMinutesBefore: 60 }, db)
    await reconcileTrip(tripId, db, NOW)
    const r = await all()
    const by = Object.fromEntries(r.map((x) => [x.kind, x]))
    expect(by.start.fireAt).toBe(zonedToUtc('2030-05-10', '09:00', 'Asia/Tokyo'))
    expect(by.leave.fireAt).toBe(zonedToUtc('2030-05-10', '09:15', 'Asia/Tokyo'))
    expect(by.trip_eve.fireAt).toBe(zonedToUtc('2030-05-09', '20:00', 'Asia/Seoul'))     // 출발 전에는 한국에 있으므로 한국 시간 저녁 8시
    expect(by.start.url).toBe(`/trips/${tripId}/day/1?item=${it.id}`)
  })
  it('no reminder for items without time, disabled, completed', async () => {
    await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '시간 없음' }, db)
    await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '꺼짐', startTime: '11:00', reminderEnabled: false }, db)
    const done = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '완료', startTime: '12:00' }, db)
    await setCompleted(done.id, true, db)
    await reconcileTrip(tripId, db, NOW)
    expect((await all()).filter((r) => r.itemId)).toHaveLength(0)
  })
  it('skips reminders whose time already passed', () => {
    const trip = { id: 't', timeZone: 'Asia/Tokyo', startDate: '2020-01-01' } as never
    const it = { id: 'i', tripId: 't', dayNumber: 1, kind: 'sight', title: 'x', startTime: '10:00', completed: false, deletedAt: null, reminderEnabled: true, reminderMinutesBefore: 30, travelMinutes: null } as never
    expect(desiredForItem(trip, it, Date.now())).toEqual([])
  })
})

describe('reminder lifecycle (update / cancel / no duplicates)', () => {
  it('is idempotent: repeated reconcile never duplicates', async () => {
    await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '저녁', startTime: '18:00' }, db)
    for (let i = 0; i < 4; i++) await reconcileTrip(tripId, db, NOW)
    expect((await all()).filter((r) => r.kind === 'start')).toHaveLength(1)
  })
  it('updating the time re-schedules the existing reminder (same id, new time)', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '저녁', startTime: '18:00', reminderMinutesBefore: 30 }, db)
    await reconcileTrip(tripId, db, NOW)
    const before = (await db.reminders.get(`${it.id}:start`))!
    await updateItem(it.id, { startTime: '19:00' }, db)
    await reconcileTrip(tripId, db, NOW)
    const after = (await db.reminders.get(`${it.id}:start`))!
    expect(after.fireAt - before.fireAt).toBe(60 * 60_000)
    expect(after.state).toBe('pending')
    expect((await all()).filter((r) => r.kind === 'start')).toHaveLength(1)
  })
  it('changing minutes-before, disabling, completing and deleting cancel/refresh', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '관광', startTime: '14:00', reminderMinutesBefore: 30 }, db)
    await reconcileTrip(tripId, db, NOW)
    const id = `${it.id}:start`
    const t0 = (await db.reminders.get(id))!.fireAt
    await updateItem(it.id, { reminderMinutesBefore: 10 }, db); await reconcileTrip(tripId, db, NOW)
    expect((await db.reminders.get(id))!.fireAt - t0).toBe(20 * 60_000)
    await updateItem(it.id, { reminderEnabled: false }, db); await reconcileTrip(tripId, db, NOW)
    expect(await db.reminders.get(id)).toBeUndefined()
    await updateItem(it.id, { reminderEnabled: true }, db); await reconcileTrip(tripId, db, NOW)
    expect(await db.reminders.get(id)).toBeDefined()
    await setCompleted(it.id, true, db); await reconcileTrip(tripId, db, NOW)
    expect(await db.reminders.get(id)).toBeUndefined()
    await setCompleted(it.id, false, db); await reconcileTrip(tripId, db, NOW)
    expect(await db.reminders.get(id)).toBeDefined()
    await deleteItem(it.id, db); await reconcileTrip(tripId, db, NOW)
    expect(await db.reminders.get(id)).toBeUndefined()
  })
  it('moving to another day or changing trip start date / timezone recomputes times', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '관광', startTime: '14:00', reminderMinutesBefore: 0 }, db)
    await reconcileTrip(tripId, db, NOW)
    const id = `${it.id}:start`
    expect((await db.reminders.get(id))!.fireAt).toBe(zonedToUtc('2030-05-10', '14:00', 'Asia/Tokyo'))
    await updateItem(it.id, { dayNumber: 2 }, db); await reconcileTrip(tripId, db, NOW)
    expect((await db.reminders.get(id))!.fireAt).toBe(zonedToUtc('2030-05-11', '14:00', 'Asia/Tokyo'))
    await updateTrip(tripId, { timeZone: 'Europe/Paris' }, db); await reconcileTrip(tripId, db, NOW)
    expect((await db.reminders.get(id))!.fireAt).toBe(zonedToUtc('2030-05-11', '14:00', 'Europe/Paris'))
    await expect(updateTrip(tripId, { timeZone: 'Mars/Base' }, db)).rejects.toThrow()
  })
  it('deleting a trip cancels all its reminders', async () => {
    await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '저녁', startTime: '18:00' }, db)
    await reconcileTrip(tripId, db, NOW)
    expect((await all()).length).toBeGreaterThan(0)
    await deleteTrip(tripId, db)
    expect(await all()).toHaveLength(0)
  })
})

describe('firing', () => {
  it('fires exactly once even if claimed repeatedly / concurrently', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '저녁', startTime: '18:00', reminderMinutesBefore: 0 }, db)
    await reconcileTrip(tripId, db, NOW)
    const at = zonedToUtc('2030-05-10', '18:00', 'Asia/Tokyo')
    expect((await claimDue(db, at - 1000)).fire).toHaveLength(0) // 아직 아님
    const results = await Promise.all([claimDue(db, at + 1000), claimDue(db, at + 1000), claimDue(db, at + 2000)])
    expect(results.flatMap((r) => r.fire).filter((r) => r.id === `${it.id}:start`)).toHaveLength(1)
    expect((await db.reminders.get(`${it.id}:start`))!.state).toBe('fired')
    expect((await claimDue(db, at + 5000)).fire).toHaveLength(0)
  })
  it('marks very late reminders as missed instead of firing', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '저녁', startTime: '18:00', reminderMinutesBefore: 0 }, db)
    await reconcileTrip(tripId, db, NOW)
    const at = zonedToUtc('2030-05-10', '18:00', 'Asia/Tokyo')
    const r = await claimDue(db, at + GRACE_MS + 60_000)
    expect(r.fire.filter((x) => x.itemId === it.id)).toHaveLength(0)
    expect(r.missed.filter((x) => x.itemId === it.id)).toHaveLength(1)
  })
  it('does not cancel a just-due, not-yet-fired reminder when reconcile runs (e.g. app reopened)', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '저녁', startTime: '18:00', reminderMinutesBefore: 0 }, db)
    await reconcileTrip(tripId, db, NOW)
    const at = zonedToUtc('2030-05-10', '18:00', 'Asia/Tokyo')
    await reconcileTrip(tripId, db, at + 2 * 60_000) // 2분 늦게 앱을 열어 재계산
    expect((await db.reminders.get(`${it.id}:start`))?.state).toBe('pending')
    expect((await claimDue(db, at + 2 * 60_000)).fire.some((r) => r.itemId === it.id)).toBe(true)
  })
  it('a long-overdue pending reminder survives reconcile and is then reported as missed (app reopened hours later)', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'flight', title: '비행', startTime: '10:00', reminderMinutesBefore: 0 }, db)
    await reconcileTrip(tripId, db, NOW)
    const at = zonedToUtc('2030-05-10', '10:00', 'Asia/Tokyo')
    const later = at + 3 * 3600_000                       // 3시간 뒤에 앱을 염
    await reconcileTrip(tripId, db, later)                 // 앱 시작 시 재계산이 먼저 실행됨
    expect((await db.reminders.get(`${it.id}:start`))?.state).toBe('pending')
    const r = await claimDue(db, later)
    expect(r.fire.some((x) => x.itemId === it.id)).toBe(false)
    expect(r.missed.some((x) => x.itemId === it.id)).toBe(true)
    // 이후 재계산이 놓친 알림을 다시 살리거나 중복 생성하지 않는다
    await reconcileTrip(tripId, db, later + 1000)
    expect((await db.reminders.get(`${it.id}:start`))?.state).toBe('missed')
    expect((await claimDue(db, later + 2000)).missed).toHaveLength(0)
  })
  it('old fired/missed records are cleaned up after 7 days without recreating alerts', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '저녁', startTime: '18:00', reminderMinutesBefore: 0 }, db)
    await reconcileTrip(tripId, db, NOW)
    const at = zonedToUtc('2030-05-10', '18:00', 'Asia/Tokyo')
    await claimDue(db, at + 1000)
    await reconcileTrip(tripId, db, at + 8 * 24 * 3600_000)
    expect(await db.reminders.get(`${it.id}:start`)).toBeUndefined()
    expect((await claimDue(db, at + 8 * 24 * 3600_000)).fire).toHaveLength(0)
  })
  it('a failure while recomputing reminders never breaks saving the itinerary item', async () => {
    await db.trips.update(tripId, { timeZone: 'Not/AZone' }) // 손상된 데이터를 흉내
    const it = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '저장은 되어야 함', startTime: '18:00' }, db)
    expect((await db.itineraryItems.get(it.id))?.title).toBe('저장은 되어야 함')
  })
  it('a fired reminder is not re-created or re-fired by later reconciles; editing the time re-arms it', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '저녁', startTime: '18:00', reminderMinutesBefore: 0 }, db)
    await reconcileTrip(tripId, db, NOW)
    const at = zonedToUtc('2030-05-10', '18:00', 'Asia/Tokyo')
    await claimDue(db, at + 1000)
    await reconcileTrip(tripId, db, at + 2000); await reconcileTrip(tripId, db, at + 3000)
    expect((await claimDue(db, at + 4000)).fire.some((r) => r.itemId === it.id)).toBe(false)
    expect((await upcomingReminders(tripId, db)).some((r) => r.itemId === it.id)).toBe(false)
    await updateItem(it.id, { startTime: '20:00' }, db)
    await reconcileTrip(tripId, db, at + 5000)
    expect((await db.reminders.get(`${it.id}:start`))!.state).toBe('pending')
  })
})
