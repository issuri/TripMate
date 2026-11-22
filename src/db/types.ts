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

export type ReminderKind = 'start' | 'leave' | 'trip_eve'
export type ReminderState = 'pending' | 'fired' | 'missed'

/**
 * 기기 로컬 알림 예약. 일정에서 파생되는 값이라 서버로 동기화하지 않는다(기기별 상태).
 * id가 결정적이라(`일정id:종류`) 같은 알림이 두 번 만들어지지 않는다.
 */
export interface Reminder {
  id: string
  tripId: string
  itemId: string | null
  kind: ReminderKind
  fireAt: number          // UTC ms (여행지 현지 시간대 기준으로 계산됨)
  title: string
  body: string
  url: string             // 알림 클릭 시 이동할 앱 내 경로
  state: ReminderState
  firedAt: number | null
}

/** 여행별 동기화 상태 */
export interface SyncMeta2 {
  tripId: string
  cursor: number           // (표시용) 서버에서 마지막으로 받은 updated_at 중 가장 늦은 값 (ms)
  cursors?: Record<string, number> // 테이블별로 마지막에 받은 updated_at (ms)
  lastSyncAt: number | null
  lastPushAt: number | null
  offlineSavedAt: number | null // "오프라인 저장"(전체 내려받기)을 완료한 시각
  lastError: string | null
  accessLost?: boolean     // 서버가 이 여행에 대한 접근을 막음(내보내짐/공유 종료). 더 이상 동기화하지 않는다
}

/** 여행 멤버 목록의 이 기기 사본(오프라인에서도 동행자를 볼 수 있게). 서버가 기준이며 동기화 엔진이 아닌 별도로 갱신한다. */
export interface MemberRow {
  id: string               // `${tripId}:${userId}`
  tripId: string
  userId: string
  displayName: string
  role: 'admin' | 'member'
  status: 'active' | 'left' | 'removed'
  joinedAt: number
  isMe: boolean
}

/**
 * 같은 필드를 동시에 고쳐 자동 병합할 수 없는 변경. 사용자가 "내 값/상대 값"을 고를 때까지 보관한다.
 * kind 'deleted' 는 내가 고치는 사이 다른 사용자가 삭제한 항목(삭제 우선이라 참고용).
 */
export interface SyncConflict {
  id: string               // `${table}:${recordId}:${field}`
  tripId: string
  table: string
  recordId: string
  field: string            // 로컬 필드명, 삭제 충돌은 '*'
  kind: 'field' | 'deleted'
  localValue: unknown
  remoteValue: unknown
  serverVersion: number
  title: string            // 화면 표시용(항목 이름)
  createdAt: number
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
  attempts?: number        // 서버가 거부한 횟수(무한 재시도 방지)
  lastError?: string
}
