// 로컬(camelCase, Dexie) ↔ 서버(snake_case, Postgres) 변환 정의. 동기화 대상 엔터티는 여기 한 곳에서 관리한다.
import type { TripMateDB } from '../db/local'
import type { Money } from '../db/types'

export type Kind = 'text' | 'int' | 'num' | 'bool' | 'ts' | 'time' | 'date' | 'arr' | 'json' | 'money'

/** 변환에 필요한 문맥: 현재 로그인한 사용자 id. 로컬의 'self' 는 서버에서는 이 id 이다. */
export interface Ctx { userId?: string | null }
export interface FieldDef { local: string; remote: string; kind: Kind }
export interface EntityDef { table: string; store: keyof TripMateDB & string; fields: FieldDef[]; hasTripId: boolean; order: number }

const f = (local: string, remote: string, kind: Kind = 'text'): FieldDef => ({ local, remote, kind })

// order: 서버 외래키 때문에 이 순서대로 보낸다(여행 → 장소/일정 → 나머지)
export const ENTITIES: EntityDef[] = [
  { table: 'trips', store: 'trips', hasTripId: false, order: 0, fields: [
    f('ownerId', 'owner_id'), f('name', 'name'), f('country', 'country'), f('city', 'city'), f('startDate', 'start_date', 'date'), f('endDate', 'end_date', 'date'),
    f('timeZone', 'time_zone'), f('purpose', 'purpose'), f('coverImage', 'cover_image'), f('status', 'status'), f('homeCurrency', 'home_currency'),
    f('localCurrency', 'local_currency'), f('totalBudgetMinor', 'total_budget_minor', 'int'), f('shoppingBudgetMinor', 'shopping_budget_minor', 'int'), f('companions', 'companions', 'arr'),
  ] },
  { table: 'places', store: 'places', hasTripId: true, order: 1, fields: [
    f('name', 'name'), f('address', 'address'), f('lat', 'lat', 'num'), f('lng', 'lng', 'num'), f('externalId', 'external_id'), f('category', 'category'),
  ] },
  { table: 'itinerary_items', store: 'itineraryItems', hasTripId: true, order: 2, fields: [
    f('dayNumber', 'day_number', 'int'), f('sortOrder', 'sort_order', 'num'), f('kind', 'kind'), f('title', 'title'), f('startTime', 'start_time', 'time'), f('endTime', 'end_time', 'time'),
    f('placeId', 'place_id'), f('locationText', 'location_text'), f('memo', 'memo'), f('travelMinutes', 'travel_minutes', 'int'), f('travelMode', 'travel_mode'),
    f('completed', 'completed', 'bool'), f('reminderEnabled', 'reminder_enabled', 'bool'), f('reminderMinutesBefore', 'reminder_minutes_before', 'int'),
  ] },
  { table: 'checklist_items', store: 'checklistItems', hasTripId: true, order: 3, fields: [f('title', 'title'), f('done', 'done', 'bool'), f('sortOrder', 'sort_order', 'num')] },
  { table: 'expense_categories', store: 'expenseCategories', hasTripId: true, order: 4, fields: [f('name', 'name'), f('budgetMinor', 'budget_minor', 'int'), f('sortOrder', 'sort_order', 'num')] },
  { table: 'shopping_items', store: 'shoppingItems', hasTripId: true, order: 5, fields: [
    f('name', 'name'), f('quantity', 'quantity', 'int'), f('expectedPriceMinor', 'expected_price_minor', 'int'), f('actualPriceMinor', 'actual_price_minor', 'int'), f('currency', 'currency'),
    f('storePlaceId', 'store_place_id'), f('itineraryItemId', 'itinerary_item_id'), f('purchased', 'purchased', 'bool'), f('memo', 'memo'),
  ] },
  // 지출: 금액·환율·결제자·분담은 money 한 필드로 병합한다(서버 expenses_validate 트리거가 합계·멤버를 검증)
  { table: 'expenses', store: 'expenses', hasTripId: true, order: 6, fields: [
    f('categoryId', 'category_id'), f('paidAt', 'paid_at', 'ts'), f('paymentMethod', 'payment_method'),
    f('itineraryItemId', 'itinerary_item_id'), f('shoppingItemId', 'shopping_item_id'), f('memo', 'memo'), f('money', 'money', 'money'),
  ] },
]

export const entityByTable = (t: string) => ENTITIES.find((e) => e.table === t)
export const entityByStore = (s: string) => ENTITIES.find((e) => e.store === s)

const pad = (n: number) => String(n).padStart(2, '0')

/** 사람 키 변환. 로컬 'self' ↔ 서버의 로그인 사용자 id (이름만 있는 동행자 'n:…' 와 다른 사용자 UUID 는 그대로). */
function mapPeople(m: Money, from: (k: string) => string): Money {
  return { ...m, payer: m.payer === null ? null : from(m.payer), splits: (m.splits ?? []).map((x) => ({ k: from(x.k), s: x.s })) }
}

/** 로컬 값 → 서버로 보낼 JSON 값 */
export function toRemoteValue(kind: Kind, v: unknown, ctx: Ctx = {}): unknown {
  if (v === undefined) return null
  if (v === null) return null
  switch (kind) {
    case 'time': return typeof v === 'string' && /^\d\d:\d\d$/.test(v) ? v + ':00' : v   // 서버 time 컬럼 표기('HH:MM:SS')에 맞춘다
    case 'ts': return new Date(v as number).toISOString()
    // 'self' 는 서버에 올라가면 안 되는 기기 내부 표기이므로 로그인 사용자 id 로 바꾼다(로그인 정보가 없으면 그대로 둬서 서버가 거부하게 한다)
    case 'money': return ctx.userId ? mapPeople(v as Money, (k) => (k === 'self' ? ctx.userId! : k)) : v
    default: return v
  }
}

/** 서버가 돌려준 값(드라이버에 따라 BigInt/Date/문자열) → 로컬 값 */
export function fromRemoteValue(kind: Kind, v: unknown, ctx: Ctx = {}): unknown {
  if (v === undefined || v === null) return null
  switch (kind) {
    case 'money': return ctx.userId ? mapPeople(v as Money, (k) => (k === ctx.userId ? 'self' : k)) : v
    case 'int': return typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v) : v
    case 'num': return typeof v === 'string' ? Number(v) : typeof v === 'bigint' ? Number(v) : v
    case 'time': return typeof v === 'string' ? v.slice(0, 5) : v
    case 'date': return v instanceof Date ? `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}` : typeof v === 'string' ? v.slice(0, 10) : v
    case 'ts': return v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : v
    default: return v
  }
}

export interface RemoteRow { [col: string]: unknown }

/** 로컬 레코드의 지정 필드(없으면 전체)를 서버 컬럼 JSON으로 */
export function toRemoteFields(def: EntityDef, rec: Record<string, unknown>, only?: string[] | null, ctx: Ctx = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const fd of def.fields) {
    if (only && !only.includes(fd.local)) continue
    // undefined(옛 버전 레코드에 없던 필드)는 보내지 않는다: null로 보내면 서버의 NOT NULL 컬럼이 거부하고,
    // 보내지 않으면 새 행은 DB 기본값, 기존 행은 기존 값을 유지한다. (값이 비어 있다는 뜻의 null 은 그대로 보낸다)
    if (rec[fd.local] === undefined) continue
    out[fd.remote] = toRemoteValue(fd.kind, rec[fd.local], ctx)
  }
  return out
}

/** 서버 행 → 로컬 필드 값들(메타 포함) */
export function fromRemoteRow(def: EntityDef, row: RemoteRow, ctx: Ctx = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const fd of def.fields) out[fd.local] = fromRemoteValue(fd.kind, row[fd.remote], ctx)
  return out
}
