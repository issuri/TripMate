export type SyncState = 'synced' | 'pending' | 'conflict'

/** 모든 동기화 대상 레코드의 공통 필드 */
export interface SyncMeta {
  id: string               // 클라이언트 생성 UUID
  tripId: string
  version: number          // 서버가 마지막으로 확인한 버전 (병합 기준)
  updatedAt: number        // 로컬 수정 시각(ms)
  deletedAt: number | null // soft delete (tombstone)
  syncState: SyncState
}

export interface Trip extends Omit<SyncMeta, 'tripId'> {
  ownerId: string
  name: string
  country: string
  city: string
  startDate: string
  endDate: string
  timeZone: string
  purpose: string
  coverImage: string | null
  status: 'planned' | 'ongoing' | 'finished'
  homeCurrency: string
  localCurrency: string
  totalBudgetMinor: number
  shoppingBudgetMinor: number
  companions: string[] // 계정 연동 전 동반자 표시용 이름
}

export type ItemKind = 'flight' | 'transit' | 'lodging_in' | 'lodging_out' | 'sight' | 'meal' | 'shopping' | 'airport' | 'other'

export interface ItineraryItem extends SyncMeta {
  dayNumber: number
  sortOrder: number
  kind: ItemKind
  title: string
  startTime: string | null
  endTime: string | null
  placeId: string | null
  locationText: string
  memo: string
  travelMinutes: number | null
  travelMode: 'walk' | 'transit' | 'drive' | null
  completed: boolean
  reminderEnabled: boolean
  reminderMinutesBefore: number
}

export interface Place extends SyncMeta {
  name: string
  address: string
  lat: number | null
  lng: number | null
  externalId: string | null // 지도 제공자의 장소 ID (예: OSM 'node/123'). 중복 저장 방지용
  category: string
}

export interface ChecklistItem extends SyncMeta {
  title: string
  done: boolean
  sortOrder: number
}

export interface ShoppingItem extends SyncMeta {
  name: string
  quantity: number
  expectedPriceMinor: number
  actualPriceMinor: number | null // 실제 결제 금액(사용자가 확인 후 입력). 예상가격으로 자동 채우지 않는다.
  currency: string
  storePlaceId: string | null
  itineraryItemId: string | null
  purchased: boolean
  expenseId: string | null
  memo: string
}

export interface ExpenseCategory extends SyncMeta {
  name: string
  budgetMinor: number
  sortOrder: number
}

export interface Expense extends SyncMeta {
  categoryId: string
  amountLocalMinor: number
  localCurrency: string
  fxRateMicro: number
  amountHomeMinor: number
  paidAt: number
  paymentMethod: string
  payerId: string | null
  isShared: boolean
  itineraryItemId: string | null
  shoppingItemId: string | null
  memo: string
}

/** 오프라인 변경 큐. 서버 전송은 id 기반 upsert라 재전송해도 중복되지 않는다. */
export interface OutboxEntry {
  seq?: number
  table: string
  recordId: string
  op: 'upsert' | 'delete'
  baseVersion: number
  changedFields: string[]  // 필드 단위 병합용
  createdAt: number
}
