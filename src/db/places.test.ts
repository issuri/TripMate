import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlaceSearch, directionsUrl, haversineM } from '../lib/maps'
import { summarizeShopping } from '../lib/shopping'
import { addItem, listItems, moveItem, byOrder } from './itinerary'
import { TripMateDB } from './local'
import { addPlace, deletePlace, listPlaces } from './places'
import { addShopping, deleteShopping, listShopping, setPurchased, updateShopping } from './shopping'
import { createTrip } from './trips'

let db: TripMateDB
let tripId: string
beforeEach(async () => {
  db = new TripMateDB('p-' + Math.random()); await db.open()
  tripId = (await createTrip({ name: 'T', country: 'JP', city: 'Tokyo', startDate: '2026-12-01', endDate: '2026-12-03' }, db)).id
})

describe('places', () => {
  it('does not duplicate the same external place', async () => {
    const a = await addPlace(tripId, { name: '센소지', externalId: 'node/1', lat: 35.71, lng: 139.79 }, db)
    const b = await addPlace(tripId, { name: '센소지(중복)', externalId: 'node/1' }, db)
    expect(b.id).toBe(a.id)
    expect(await listPlaces(tripId, db)).toHaveLength(1)
  })
  it('rejects bad coordinates', async () => {
    await expect(addPlace(tripId, { name: 'x', lat: 123, lng: 0 }, db)).rejects.toThrow()
  })
  it('deleting a place keeps the itinerary item and its name', async () => {
    const p = await addPlace(tripId, { name: '스카이트리', lat: 35.71, lng: 139.81 }, db)
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '전망대', placeId: p.id }, db)
    await deletePlace(p.id, db)
    const after = (await listItems(tripId, db))[0]
    expect(after.id).toBe(it.id)
    expect(after.placeId).toBeNull()
    expect(after.locationText).toBe('스카이트리')
  })
  it('reordering items changes the order used for the route', async () => {
    const p1 = await addPlace(tripId, { name: 'A', lat: 1, lng: 1 }, db)
    const p2 = await addPlace(tripId, { name: 'B', lat: 2, lng: 2 }, db)
    const a = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: 'a', placeId: p1.id }, db)
    await addItem(tripId, { dayNumber: 1, kind: 'sight', title: 'b', placeId: p2.id }, db)
    await moveItem(a.id, 1, db)
    const names = (await listItems(tripId, db)).sort(byOrder).map((i) => i.placeId === p1.id ? 'A' : 'B')
    expect(names).toEqual(['B', 'A'])
  })
})

describe('shopping', () => {
  it('purchase check never copies expected price into actual', async () => {
    const s = await addShopping(tripId, { name: '과자', quantity: 3, expectedPriceMinor: 500 }, db)
    await setPurchased(s.id, true, undefined, db)
    const cur = (await listShopping(tripId, db))[0]
    expect(cur.purchased).toBe(true)
    expect(cur.actualPriceMinor).toBeNull()
    expect(cur.expenseId).toBeNull()
    expect(await db.expenses.count()).toBe(0)
    const sum = summarizeShopping(await listShopping(tripId, db), 5000)
    expect(sum.unpricedPurchased).toBe(1)
    expect(sum.actualMinor).toBe(0)
  })
  it('summary: expected, actual, budget', async () => {
    const a = await addShopping(tripId, { name: 'a', quantity: 2, expectedPriceMinor: 1000 }, db)
    await addShopping(tripId, { name: 'b', expectedPriceMinor: 3000 }, db)
    await setPurchased(a.id, true, 1800, db)
    const s = summarizeShopping(await listShopping(tripId, db), 5000)
    expect(s).toMatchObject({ expectedMinor: 5000, actualMinor: 1800, remainingExpectedMinor: 3000, projectedMinor: 4800, overBudget: false })
    expect(summarizeShopping(await listShopping(tripId, db), 4000).overBudget).toBe(true)
  })
  it('unchecking clears actual price; validation; tombstone', async () => {
    const s = await addShopping(tripId, { name: 'x' }, db)
    await setPurchased(s.id, true, 700, db)
    await setPurchased(s.id, false, undefined, db)
    expect((await db.shoppingItems.get(s.id))?.actualPriceMinor).toBeNull()
    await expect(addShopping(tripId, { name: ' ' }, db)).rejects.toThrow()
    await expect(updateShopping(s.id, { quantity: 0 }, db)).rejects.toThrow()
    await deleteShopping(s.id, db)
    expect(await listShopping(tripId, db)).toHaveLength(0)
    await expect(updateShopping(s.id, { name: 'zombie' }, db)).rejects.toThrow()
  })
  it('check-only change records only the changed fields (merge-friendly)', async () => {
    const s = await addShopping(tripId, { name: 'x' }, db)
    await db.outbox.clear()
    await setPurchased(s.id, true, 100, db)
    const e = (await db.outbox.toArray())[0]
    expect(e.changedFields.sort()).toEqual(['actualPriceMinor', 'purchased'])
  })
})

describe('maps helpers', () => {
  it('builds a Google Maps directions URL with waypoints', () => {
    const url = directionsUrl([
      { name: 'A', lat: 35.1, lng: 139.1 }, { name: 'B', lat: 35.2, lng: 139.2 }, { name: 'C', lat: null, lng: null, address: 'Tokyo Tower' },
    ], 'walking')!
    expect(url).toContain('origin=35.1%2C139.1')
    expect(url).toContain('waypoints=35.2%2C139.2')
    expect(url).toContain('destination=C+Tokyo+Tower')
    expect(url).toContain('travelmode=walking')
    expect(directionsUrl([{ name: 'A', lat: 1, lng: 1 }])).toBeNull()
  })
  it('haversine ~ known distance', () => {
    const d = haversineM({ lat: 37.5665, lng: 126.978 }, { lat: 35.1796, lng: 129.0756 }) // 서울-부산
    expect(d / 1000).toBeGreaterThan(320); expect(d / 1000).toBeLessThan(330)
  })
})

describe('place search (Nominatim policy)', () => {
  const rows = [{ osm_type: 'node', osm_id: 7, lat: '35.7148', lon: '139.7967', display_name: '浅草寺, 台東区, 東京都, 日本', name: '浅草寺' }]
  const mkStorage = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }

  it('maps results, caches repeated queries, sends no request for cached ones', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(rows)))
    const search = createPlaceSearch({ fetchFn: fetchFn as unknown as typeof fetch, storage: mkStorage(), sleep: async () => {} })
    const a = await search('센소지 도쿄')
    expect(a.cached).toBe(false)
    expect(a.results[0]).toMatchObject({ id: 'node/7', name: '浅草寺', lat: 35.7148, lng: 139.7967 })
    const b = await search('  센소지   도쿄 ')
    expect(b.cached).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('keeps at least 1.1s between network requests', async () => {
    let t = 1_000_000
    const waits: number[] = []
    const fetchFn = vi.fn(async () => new Response('[]'))
    const search = createPlaceSearch({
      fetchFn: fetchFn as unknown as typeof fetch, storage: mkStorage(), now: () => t,
      sleep: async (ms) => { waits.push(ms); t += ms },
    })
    await Promise.all([search('aa'), search('bb'), search('cc')])
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(waits.length).toBe(2)
    expect(waits.every((w) => w >= 1000)).toBe(true)
  })
  it('turns network failures and malformed responses into readable Korean errors, and drops invalid rows', async () => {
    const offline = createPlaceSearch({ fetchFn: (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch, storage: mkStorage(), sleep: async () => {} })
    await expect(offline('도쿄 타워')).rejects.toThrow(/인터넷/)
    const html = createPlaceSearch({ fetchFn: (async () => new Response('<html>')) as unknown as typeof fetch, storage: mkStorage(), sleep: async () => {} })
    await expect(html('도쿄 타워')).rejects.toThrow(/읽지 못했어요/)
    const mixed = [...rows, { osm_type: 'node', osm_id: 8, lat: 'abc', lon: '1', display_name: 'bad' }, { osm_type: 'node', osm_id: 9, lat: '99', lon: '1', display_name: 'out of range' }]
    const ok = createPlaceSearch({ fetchFn: (async () => new Response(JSON.stringify(mixed))) as unknown as typeof fetch, storage: mkStorage(), sleep: async () => {} })
    expect((await ok('센소지')).results).toHaveLength(1)
  })
  it('rejects too-short queries and reports rate-limit errors', async () => {
    const search = createPlaceSearch({ fetchFn: (async () => new Response('', { status: 429 })) as unknown as typeof fetch, storage: mkStorage(), sleep: async () => {} })
    await expect(search('a')).rejects.toThrow()
    await expect(search('abc')).rejects.toThrow(/너무 많아요/)
  })
})
