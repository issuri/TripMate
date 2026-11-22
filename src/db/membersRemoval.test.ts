// 동행자 공유를 없애면서 지운 로컬 테이블(members). 이미 쓰던 사용자의 저장소가 데이터를 잃지 않고 새 버전으로 올라가는지 확인한다.
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { TripMateDB } from './local'

describe('upgrading a database that still has the old members table', () => {
  it('drops members and keeps trips, expenses and settings', async () => {
    const name = 'old-with-members'
    // 예전 버전(v6): members 테이블이 있고 데이터가 들어 있다
    const old = new Dexie(name)
    old.version(1).stores({ trips: 'id, startDate, syncState', itineraryItems: 'id, [tripId+dayNumber], tripId, syncState', places: 'id, tripId, syncState', checklistItems: 'id, tripId, syncState', shoppingItems: 'id, tripId, syncState', expenseCategories: 'id, tripId, syncState', expenses: 'id, tripId, paidAt, syncState', outbox: '++seq, table, recordId' })
    old.version(2).stores({ reminders: 'id, tripId, itemId, fireAt, state' })
    old.version(3).stores({ syncMeta: 'tripId', conflicts: 'id, tripId, recordId' })
    old.version(4).stores({ members: 'id, tripId, userId' })
    old.version(5).stores({ exclusions: 'tripId' })
    old.version(6).stores({ remindersOff: 'tripId' })
    await old.open()
    await old.table('trips').add({ id: 't1', name: '옛 여행', country: '일본', city: '도쿄', startDate: '2030-05-10', endDate: '2030-05-12', timeZone: 'Asia/Tokyo', localCurrency: 'JPY', companions: ['민수'], deletedAt: null })
    await old.table('members').bulkAdd([{ id: 't1:u1', tripId: 't1', userId: 'u1', displayName: '나', role: 'admin', status: 'active', joinedAt: 1, isMe: true }, { id: 't1:u2', tripId: 't1', userId: 'u2', displayName: '민수', role: 'member', status: 'active', joinedAt: 2, isMe: false }])
    await old.table('remindersOff').add({ tripId: 't1', at: 5 })
    old.close()

    const now = new TripMateDB(name)
    await now.open()
    expect(now.tables.map((t) => t.name)).not.toContain('members')
    expect((await now.trips.get('t1'))?.name).toBe('옛 여행')                 // 여행은 그대로
    expect((await now.trips.get('t1'))?.companions).toEqual(['민수'])         // 동반자 이름도 그대로(정산에 쓰인다)
    expect(await now.remindersOff.get('t1')).toBeTruthy()                    // 알림 설정도 그대로
    now.close()
  })

  it('a fresh database has no members table either', async () => {
    const fresh = new TripMateDB('fresh-no-members')
    await fresh.open()
    expect(fresh.tables.map((t) => t.name)).not.toContain('members')
    fresh.close()
  })
})
