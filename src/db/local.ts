import Dexie, { type Table } from 'dexie'
import type {
  ChecklistItem, Expense, ExpenseCategory, ItineraryItem, OutboxEntry, Place, ShoppingItem, Trip,
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
  }
}

export const db = new TripMateDB()
