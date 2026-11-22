// 이전 버전 앱이 만든 로컬 DB(필드가 일부 없는 오래된 레코드)를 새 버전이 열어도 깨지지 않는지 확인한다.
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { summarizeShopping } from '../lib/shopping'
import { addItem, listItems, moveItem, setCompleted, updateItem } from './itinerary'
import { queueOrphanedLocalRecords, TripMateDB } from './local'
import { addPlace } from './places'
import { claimDue, reconcileTrip } from './reminders'
import { listShopping, setPurchased, updateShopping } from './shopping'
import { listTrips } from './trips'

const meta = { version: 0, updatedAt: 1, deletedAt: null, syncState: 'pending' as const }

async function seedV1(name: string) {
  const old = new Dexie(name)
  old.version(1).stores({
    trips: 'id, startDate, syncState', itineraryItems: 'id, [tripId+dayNumber], tripId, syncState', places: 'id, tripId, syncState',
    checklistItems: 'id, tripId, syncState', shoppingItems: 'id, tripId, syncState', expenseCategories: 'id, tripId, syncState',
    expenses: 'id, tripId, paidAt, syncState', outbox: '++seq, table, recordId',
  })
  await old.open()
  // 알림 필드·locationText·actualPriceMinor·externalId 가 없던 시절의 레코드
  await old.table('trips').add({ id: 't1', ...meta, ownerId: 'local', name: '옛 여행', country: '', city: '', startDate: '2030-05-10', endDate: '2030-05-12', timeZone: 'Asia/Tokyo', purpose: '', coverImage: null, status: 'planned', homeCurrency: 'KRW', localCurrency: 'JPY', totalBudgetMinor: 0, shoppingBudgetMinor: 0, companions: [] })
  await old.table('itineraryItems').bulkAdd([
    { id: 'i1', tripId: 't1', ...meta, dayNumber: 1, sortOrder: 1, kind: 'sight', title: '옛 일정 A', startTime: '10:00', endTime: null, placeId: null, memo: '', travelMinutes: null, travelMode: null, completed: false },
    { id: 'i2', tripId: 't1', ...meta, dayNumber: 1, sortOrder: 2, kind: 'meal', title: '옛 일정 B', startTime: '12:00', endTime: null, placeId: null, memo: '', travelMinutes: 15, travelMode: 'walk', completed: false },
  ])
  await old.table('places').add({ id: 'p1', tripId: 't1', ...meta, name: '옛 장소', address: '', lat: 35.1, lng: 139.1, googlePlaceId: null, category: 'sight' })
  await old.table('shoppingItems').add({ id: 's1', tripId: 't1', ...meta, name: '옛 상품', quantity: 2, expectedPriceMinor: 500, currency: 'JPY', storePlaceId: null, itineraryItemId: null, purchased: true, expenseId: null, memo: '' })
  old.close()
}

describe('upgrading an existing local database', () => {
  it('opens a v1 database, keeps data, and adds the reminders table', async () => {
    const name = 'legacy-' + Math.random()
    await seedV1(name)
    const db = new TripMateDB(name); await db.open()
    expect(await db.trips.count()).toBe(1)
    expect(await db.reminders.count()).toBe(0)
    expect((await listTrips(db))[0].name).toBe('옛 여행')
  })

  it('upgrade queues pre-sync records that were never queued, without duplicating queued ones', async () => {
    const name = 'legacy3-' + Math.random()
    await seedV1(name)
    const old = new Dexie(name)
    old.version(1).stores({
      trips: 'id, startDate, syncState', itineraryItems: 'id, [tripId+dayNumber], tripId, syncState', places: 'id, tripId, syncState',
      checklistItems: 'id, tripId, syncState', shoppingItems: 'id, tripId, syncState', expenseCategories: 'id, tripId, syncState',
      expenses: 'id, tripId, paidAt, syncState', outbox: '++seq, table, recordId',
    })
    await old.open()
    // 여행 생성 시 기본 체크리스트는 큐에 안 들어갔고, 일정 i1 은 큐에 이미 있는 상태
    await old.table('checklistItems').add({ id: 'c1', tripId: 't1', ...meta, title: '여권', done: false, sortOrder: 0 })
    await old.table('outbox').add({ table: 'itinerary_items', recordId: 'i1', op: 'upsert', baseVersion: 0, changedFields: ['*'], createdAt: 1 })
    old.close()
    const db = new TripMateDB(name); await db.open()
    const added = await queueOrphanedLocalRecords(db)
    expect(added).toBeGreaterThan(0)
    expect(await queueOrphanedLocalRecords(db)).toBe(0)                    // 멱등: 두 번째는 아무것도 추가하지 않음
    const q = await db.outbox.toArray()
    expect(q.filter((e) => e.recordId === 'c1')).toHaveLength(1)           // 큐에 없던 항목이 추가됨
    expect(q.filter((e) => e.recordId === 'i1')).toHaveLength(1)           // 이미 있던 항목은 중복 추가되지 않음
    expect(q.some((e) => e.recordId === 't1')).toBe(true)
  })

  it('legacy records without newer fields still work everywhere', async () => {
    const name = 'legacy2-' + Math.random()
    await seedV1(name)
    const db = new TripMateDB(name); await db.open()
    // 알림: 필드가 없는 옛 일정(reminderEnabled 없음)은 켜짐으로 취급되지 않으므로 오류 없이 건너뛴다
    await expect(reconcileTrip('t1', db, 0)).resolves.toBeUndefined()
    const items = await listItems('t1', db)
    expect(items).toHaveLength(2)
    // 수정/이동/완료가 옛 레코드에서도 동작
    await updateItem('i1', { memo: '메모 추가', reminderEnabled: true, reminderMinutesBefore: 10 }, db)
    await moveItem('i2', -1, db)
    await setCompleted('i1', true, db)
    const a = (await db.itineraryItems.get('i1'))!
    expect([a.memo, a.completed, a.reminderEnabled]).toEqual(['메모 추가', true, true])
    // 옛 일정에 알림을 켜면 예약된다
    await updateItem('i2', { reminderEnabled: true, reminderMinutesBefore: 30 }, db)
    await reconcileTrip('t1', db, 0)
    expect(await db.reminders.get('i2:start')).toBeDefined()
    expect(await db.reminders.get('i2:leave')).toBeDefined()
    await claimDue(db, 1)
    // 쇼핑: 실제 금액 필드가 없던 구매 완료 상품은 "금액 미입력"으로 집계
    const s = summarizeShopping(await listShopping('t1', db), 0)
    expect(s).toMatchObject({ purchasedCount: 1, unpricedPurchased: 1, actualMinor: 0 })
    await setPurchased('s1', true, 450, db)
    await updateShopping('s1', { name: '이름 변경' }, db)
    expect(summarizeShopping(await listShopping('t1', db), 0).actualMinor).toBe(450)
    // 장소: 외부 ID 필드가 없던 옛 장소와 같은 이름·좌표는 중복 저장되지 않는다
    const dup = await addPlace('t1', { name: '옛 장소', lat: 35.1, lng: 139.1 }, db)
    expect(dup.id).toBe('p1')
    // 새 일정 추가도 정상
    const n = await addItem('t1', { dayNumber: 2, kind: 'sight', title: '새 일정', startTime: '09:00' }, db)
    expect(n.reminderEnabled).toBe(true)
  })
})
