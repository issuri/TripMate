import Dexie, { type Table } from 'dexie'
import type {
  ChecklistItem, Expense, ExpenseCategory, ItineraryItem, MemberRow, OutboxEntry, Place, Reminder, ShoppingItem, SyncConflict, SyncMeta2, Trip,
} from './types'

export class TripMateDB extends Dexie {
  trips!: Table<Trip, string>
  itineraryItems!: Table<ItineraryItem, string>
  places!: Table<Place, string>
  checklistItems!: Table<ChecklistItem, string>
  shoppingItems!: Table<ShoppingItem, string>
  expenseCategories!: Table<ExpenseCategory, string>
  expenses!: Table<Expense, string>
  outbox!: Table<OutboxEntry, number>
  reminders!: Table<Reminder, string>
  syncMeta!: Table<SyncMeta2, string>
  conflicts!: Table<SyncConflict, string>
  members!: Table<MemberRow, string>
  exclusions!: Table<{ tripId: string; at: number }, string>
  remindersOff!: Table<{ tripId: string; at: number }, string>

  constructor(name = 'tripmate') {
    super(name)
    // 스키마 변경은 반드시 version(n+1)을 추가하는 마이그레이션으로만 한다.
    this.version(1).stores({
      trips: 'id, startDate, syncState',
      itineraryItems: 'id, [tripId+dayNumber], tripId, syncState',
      places: 'id, tripId, syncState',
      checklistItems: 'id, tripId, syncState',
      shoppingItems: 'id, tripId, syncState',
      expenseCategories: 'id, tripId, syncState',
      expenses: 'id, tripId, paidAt, syncState',
      outbox: '++seq, table, recordId',
    })
    // v2: 기기 로컬 알림 예약 테이블 추가 (기존 데이터는 그대로 유지)
    this.version(2).stores({ reminders: 'id, tripId, itemId, fireAt, state' })
    // v3: 동기화 상태(여행별)와 충돌 보관 테이블
    this.version(3).stores({ syncMeta: 'tripId', conflicts: 'id, tripId, recordId' })
    // v4: 여행 멤버 목록 사본
    this.version(4).stores({ members: 'id, tripId, userId' })
    // v5: 이 기기에서 사본을 지운 여행(자동으로 다시 내려받지 않도록 기억)
    this.version(5).stores({ exclusions: 'tripId' })
    // v6: 이 기기에서 알림을 끈 여행(알림은 기기마다 따로 설정한다. 서버에는 올리지 않는다)
    this.version(6).stores({ remindersOff: 'tripId' })
  }
}

export const db = new TripMateDB()

/**
 * 서버에 한 번도 올라간 적 없는데(version 0) 동기화 큐에도 없는 레코드를 큐에 넣는다. 멱등.
 * 동기화 도입 전에 만든 데이터(예: 여행 생성 때 자동으로 만든 기본 지출 항목·체크리스트)가 서버에 영원히 올라가지 않는 것을 막는다.
 */
export async function queueOrphanedLocalRecords(d: TripMateDB = db): Promise<number> {
  const targets: [keyof TripMateDB & string, string][] = [['trips', 'trips'], ['places', 'places'], ['itineraryItems', 'itinerary_items'], ['checklistItems', 'checklist_items'], ['expenseCategories', 'expense_categories'], ['shoppingItems', 'shopping_items'], ['expenses', 'expenses']]
  let added = 0
  await d.transaction('rw', [d.trips, d.places, d.itineraryItems, d.checklistItems, d.expenseCategories, d.shoppingItems, d.expenses, d.outbox], async () => {
    const queued = new Set((await d.outbox.toArray()).map((e) => e.recordId))
    for (const [store, serverTable] of targets) {
      const rows = (await (d[store as 'trips'] as unknown as Table<{ id: string; version?: number; deletedAt: number | null }, string>).toArray())
      for (const r of rows) {
        // 서버가 모르는 채로 삭제된 레코드는 보낼 것이 없다(큐에 넣으면 시작할 때마다 넣고 지우는 일이 반복된다)
        if ((r.version ?? 0) === 0 && !r.deletedAt && !queued.has(r.id)) {
          await d.outbox.add({ table: serverTable, recordId: r.id, op: 'upsert', baseVersion: 0, changedFields: ['*'], createdAt: Date.now() })
          added++
        }
      }
    }
  })
  return added
}
