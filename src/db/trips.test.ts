import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { tripDays, computeStatus } from '../lib/dates'
import { TripMateDB } from './local'
import { createTrip, deleteTrip, listTrips, DEFAULT_CATEGORIES } from './trips'

let db: TripMateDB
beforeEach(async () => { db = new TripMateDB('test-' + Math.random()); await db.open() })

const base = { name: '도쿄 여행', country: '일본', city: '도쿄', startDate: '2026-12-01', endDate: '2026-12-04' }

describe('createTrip', () => {
  it('creates trip with default categories, checklist and outbox entry', async () => {
    const t = await createTrip(base, db)
    expect(await db.expenseCategories.where({ tripId: t.id }).count()).toBe(DEFAULT_CATEGORIES.length)
    expect(await db.checklistItems.where({ tripId: t.id }).count()).toBeGreaterThan(0)
    expect(await db.outbox.count()).toBe(1)
    expect(t.syncState).toBe('pending')
  })
  it('rejects invalid dates', async () => {
    await expect(createTrip({ ...base, endDate: '2026-11-01' }, db)).rejects.toThrow()
    await expect(createTrip({ ...base, name: ' ' }, db)).rejects.toThrow()
  })
  it('delete is a tombstone and hidden from list', async () => {
    const t = await createTrip(base, db)
    await deleteTrip(t.id, db)
    expect(await listTrips(db)).toHaveLength(0)
    expect((await db.trips.get(t.id))?.deletedAt).not.toBeNull()
  })
})

describe('dates', () => {
  it('builds DAY list', () => {
    const d = tripDays('2026-12-30', '2027-01-02')
    expect(d.map((x) => x.date)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
    expect(d[3].dayNumber).toBe(4)
  })
  it('computes status in destination timezone', () => {
    const now = new Date('2026-12-02T00:00:00Z')
    expect(computeStatus('2026-12-01', '2026-12-04', 'Asia/Tokyo', now)).toBe('ongoing')
    expect(computeStatus('2026-12-05', '2026-12-06', 'Asia/Tokyo', now)).toBe('planned')
    expect(computeStatus('2026-11-01', '2026-11-02', 'Asia/Tokyo', now)).toBe('finished')
  })
})
