import { v4 as uuid } from 'uuid'
import { isValidTimeZone } from '../lib/tz'
import { db as defaultDb, type TripMateDB } from './local'
import { reconcileTripSafe } from './reminders'
import type { ChecklistItem, ItineraryItem, Trip } from './types'

type Table = 'trips' | 'itineraryItems' | 'checklistItems'
const SERVER_TABLE: Record<Table, string> = { trips: 'trips', itineraryItems: 'itinerary_items', checklistItems: 'checklist_items' }

const PENDING = () => ({ updatedAt: Date.now(), syncState: 'pending' as const })

async function log(db: TripMateDB, table: Table, recordId: string, op: 'upsert' | 'delete', baseVersion: number, fields: string[]) {
  await db.outbox.add({ table: SERVER_TABLE[table], recordId, op, baseVersion, changedFields: fields, createdAt: Date.now() })
}

// ───────── 정렬 (분수 인덱싱: 순서 변경 시 한 행만 수정되어 동시 편집에 안전) ─────────
export const byOrder = <T extends { sortOrder: number }>(a: T, b: T) => a.sortOrder - b.sortOrder

/** 시작 시간이 있으면 시간순 위치에, 없으면 맨 뒤에 넣을 sortOrder */
export function sortOrderFor(items: ItineraryItem[], startTime: string | null): number {
  const sorted = [...items].sort(byOrder)
  if (!sorted.length) return 1
  if (startTime) {
    const idx = sorted.findIndex((i) => i.startTime && i.startTime > startTime)
    if (idx === 0) return sorted[0].sortOrder - 1
    if (idx > 0) return (sorted[idx - 1].sortOrder + sorted[idx].sortOrder) / 2
  }
  return sorted[sorted.length - 1].sortOrder + 1
}

export function orderAfterMove(sorted: ItineraryItem[], id: string, dir: -1 | 1): number | null {
  const i = sorted.findIndex((x) => x.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= sorted.length) return null
  const a = sorted[j].sortOrder
  const b = sorted[j + dir]?.sortOrder ?? a + dir
  return (a + b) / 2
}

// ───────── 일정 ─────────
export type ItemInput = Pick<ItineraryItem, 'dayNumber' | 'kind' | 'title'> & Partial<Pick<ItineraryItem,
  'placeId' | 'startTime' | 'endTime' | 'locationText' | 'memo' | 'travelMinutes' | 'travelMode' | 'reminderEnabled' | 'reminderMinutesBefore'>>

export function validateItem(i: Pick<ItemInput, 'title' | 'startTime' | 'endTime'> & { travelMinutes?: number | null; reminderMinutesBefore?: number; memo?: string; locationText?: string }): string | null {
  if (!i.title.trim()) return '제목을 입력하세요.'
  if (i.title.length > 200 || (i.memo?.length ?? 0) > 2000 || (i.locationText?.length ?? 0) > 300) return '입력한 글자 수가 너무 많습니다.'
  if (i.reminderMinutesBefore !== undefined && (!Number.isInteger(i.reminderMinutesBefore) || i.reminderMinutesBefore < 0 || i.reminderMinutesBefore > 10080)) return '알림 시간이 올바르지 않습니다.'
  if (i.travelMinutes != null && (!Number.isInteger(i.travelMinutes) || i.travelMinutes < 0 || i.travelMinutes > 3000)) return '이동 시간은 0~3000분 사이 숫자로 입력하세요.'
  for (const t of [i.startTime, i.endTime]) if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return '시간 형식이 올바르지 않습니다.'
  // 종료 시간이 시작보다 빠르면 다음 날 종료(예: 22:00~01:00 야간 이동)로 해석한다. 오류로 막지 않는다.
  return null
}

export async function addItem(tripId: string, input: ItemInput, db: TripMateDB = defaultDb): Promise<ItineraryItem> {
  const err = validateItem(input)
  if (err) throw new Error(err)
  const siblings = await db.itineraryItems.where({ tripId, dayNumber: input.dayNumber }).filter((i) => i.deletedAt === null).toArray()
  const item: ItineraryItem = {
    id: uuid(), tripId, version: 0, deletedAt: null, ...PENDING(),
    dayNumber: input.dayNumber, kind: input.kind, title: input.title.trim(),
    startTime: input.startTime || null, endTime: input.endTime || null,
    sortOrder: sortOrderFor(siblings, input.startTime || null),
    placeId: input.placeId ?? null, locationText: input.locationText ?? '', memo: input.memo ?? '',
    travelMinutes: input.travelMinutes ?? null, travelMode: input.travelMode ?? null,
    completed: false, reminderEnabled: input.reminderEnabled ?? true, reminderMinutesBefore: input.reminderMinutesBefore ?? 30,
  }
  await db.transaction('rw', db.itineraryItems, db.outbox, async () => {
    await db.itineraryItems.add(item)
    await log(db, 'itineraryItems', item.id, 'upsert', 0, ['*'])
  })
  await reconcileTripSafe(tripId, db) // 일정 알림 예약
  return item
}

export async function updateItem(id: string, patch: Partial<ItemInput>, db: TripMateDB = defaultDb) {
  let tripId = ''
  await db.transaction('rw', db.itineraryItems, db.outbox, async () => {
    const cur = await db.itineraryItems.get(id)
    if (!cur || cur.deletedAt !== null) throw new Error('일정을 찾을 수 없습니다. 다른 사용자가 삭제했을 수 있습니다.')
    tripId = cur.tripId
    const next = { ...cur, ...patch }
    const err = validateItem(next)
    if (err) throw new Error(err)
    const changes: Partial<ItineraryItem> = { ...patch, ...PENDING() }
    if (patch.title !== undefined) changes.title = patch.title.trim()
    if (patch.dayNumber !== undefined && patch.dayNumber !== cur.dayNumber) {
      const sib = await db.itineraryItems.where({ tripId: cur.tripId, dayNumber: patch.dayNumber }).filter((i) => i.deletedAt === null).toArray()
      changes.sortOrder = sortOrderFor(sib, next.startTime)
    }
    await db.itineraryItems.update(id, changes)
    await log(db, 'itineraryItems', id, 'upsert', cur.version, Object.keys(changes).filter((k) => k !== 'syncState'))
  })
  await reconcileTripSafe(tripId, db) // 시간/알림 설정이 바뀌면 기존 예약을 갱신
}

export const setCompleted = (id: string, completed: boolean, db: TripMateDB = defaultDb) => updateItemRaw(id, { completed }, db)

async function updateItemRaw(id: string, patch: Partial<ItineraryItem>, db: TripMateDB) {
  let tripId = ''
  await db.transaction('rw', db.itineraryItems, db.outbox, async () => {
    const cur = await db.itineraryItems.get(id)
    if (!cur || cur.deletedAt !== null) return
    tripId = cur.tripId
    await db.itineraryItems.update(id, { ...patch, ...PENDING() })
    await log(db, 'itineraryItems', id, 'upsert', cur.version, Object.keys(patch))
  })
  if (tripId && 'completed' in patch) await reconcileTripSafe(tripId, db) // 완료한 일정은 알림 제외, 해제하면 다시 예약
}

export async function moveItem(id: string, dir: -1 | 1, db: TripMateDB = defaultDb) {
  const cur = await db.itineraryItems.get(id)
  if (!cur) return
  const sib = (await db.itineraryItems.where({ tripId: cur.tripId, dayNumber: cur.dayNumber }).filter((i) => i.deletedAt === null).toArray()).sort(byOrder)
  const order = orderAfterMove(sib, id, dir)
  if (order !== null) await updateItemRaw(id, { sortOrder: order }, db)
}

export async function deleteItem(id: string, db: TripMateDB = defaultDb) {
  let tripId = ''
  await db.transaction('rw', db.itineraryItems, db.outbox, async () => {
    const cur = await db.itineraryItems.get(id)
    if (!cur || cur.deletedAt !== null) return
    tripId = cur.tripId
    await db.itineraryItems.update(id, { deletedAt: Date.now(), ...PENDING() })
    await log(db, 'itineraryItems', id, 'delete', cur.version, ['deletedAt'])
  })
  if (tripId) await reconcileTripSafe(tripId, db) // 삭제한 일정의 알림 취소
}

export const listItems = async (tripId: string, db: TripMateDB = defaultDb) =>
  (await db.itineraryItems.where('tripId').equals(tripId).filter((i) => i.deletedAt === null).toArray())

// ───────── 체크리스트 ─────────
export async function addChecklist(tripId: string, title: string, db: TripMateDB = defaultDb) {
  if (!title.trim()) throw new Error('항목을 입력하세요.')
  if (title.length > 200) throw new Error('입력한 글자 수가 너무 많습니다.')
  const all = await db.checklistItems.where('tripId').equals(tripId).toArray()
  const c: ChecklistItem = {
    id: uuid(), tripId, version: 0, deletedAt: null, ...PENDING(),
    title: title.trim(), done: false, sortOrder: Math.max(0, ...all.map((x) => x.sortOrder)) + 1,
  }
  await db.transaction('rw', db.checklistItems, db.outbox, async () => {
    await db.checklistItems.add(c)
    await log(db, 'checklistItems', c.id, 'upsert', 0, ['*'])
  })
}

export async function setChecklistDone(id: string, done: boolean, db: TripMateDB = defaultDb) {
  await db.transaction('rw', db.checklistItems, db.outbox, async () => {
    const cur = await db.checklistItems.get(id)
    if (!cur) return
    await db.checklistItems.update(id, { done, ...PENDING() })
    await log(db, 'checklistItems', id, 'upsert', cur.version, ['done'])
  })
}

export async function deleteChecklist(id: string, db: TripMateDB = defaultDb) {
  await db.transaction('rw', db.checklistItems, db.outbox, async () => {
    const cur = await db.checklistItems.get(id)
    if (!cur) return
    await db.checklistItems.update(id, { deletedAt: Date.now(), ...PENDING() })
    await log(db, 'checklistItems', id, 'delete', cur.version, ['deletedAt'])
  })
}

// ───────── 여행 수정 ─────────
export async function updateTrip(id: string, patch: Partial<Pick<Trip, 'name' | 'country' | 'city' | 'startDate' | 'endDate' | 'timeZone' | 'purpose' | 'companions' | 'coverImage' | 'localCurrency' | 'totalBudgetMinor' | 'shoppingBudgetMinor'>>, db: TripMateDB = defaultDb) {
  await db.transaction('rw', db.trips, db.itineraryItems, db.outbox, async () => {
    const cur = await db.trips.get(id)
    if (!cur) throw new Error('여행을 찾을 수 없습니다.')
    // 허용된 필드만 반영(버전·id·동기화 상태 등을 화면 쪽 오래된 값으로 덮어쓰지 않도록)
    const ALLOWED = ['name', 'country', 'city', 'startDate', 'endDate', 'timeZone', 'purpose', 'companions', 'coverImage', 'localCurrency', 'totalBudgetMinor', 'shoppingBudgetMinor']
    // 실제로 바뀐 필드만 기록한다(동행자가 같은 시간에 고친 다른 필드를 오래된 값으로 덮어쓰지 않도록 필드 단위 병합)
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    patch = Object.fromEntries(Object.entries(patch).filter(([k, v]) => ALLOWED.includes(k) && v !== undefined && !same(v, (cur as unknown as Record<string, unknown>)[k])))
    if (Object.keys(patch).length === 0) return // 변경 없음: 큐에 기록하지 않음
    const next = { ...cur, ...patch }
    if (!next.name.trim()) throw new Error('여행 이름을 입력하세요.')
    if (next.name.length > 200 || next.country.length > 100 || next.city.length > 100 || next.purpose.length > 500 || next.companions.length > 20) throw new Error('입력한 글자 수가 너무 많습니다.')
    if (next.coverImage && next.coverImage.length > 1_500_000) throw new Error('대표 이미지가 너무 큽니다. 더 작은 사진을 선택하세요.')
    if (next.endDate < next.startDate) throw new Error('종료일은 시작일 이후여야 합니다.')
    const days = Math.round((Date.parse(next.endDate) - Date.parse(next.startDate)) / 86400000) + 1
    // 기간을 줄이면 범위를 벗어나는 일정이 사라지지 않도록 마지막 날로 옮긴다(데이터 유실 방지).
    const orphans = await db.itineraryItems.where('tripId').equals(id).filter((i) => i.deletedAt === null && i.dayNumber > days).toArray()
    for (const o of orphans) {
      await db.itineraryItems.update(o.id, { dayNumber: days, ...PENDING() })
      await log(db, 'itineraryItems', o.id, 'upsert', o.version, ['dayNumber'])
    }
    if (!isValidTimeZone(next.timeZone)) throw new Error('시간대가 올바르지 않습니다.')
    await db.trips.update(id, { ...patch, ...PENDING() })
    await log(db, 'trips', id, 'upsert', cur.version, Object.keys(patch))
  })
  await reconcileTripSafe(id, db) // 출발일/시간대가 바뀌면 모든 알림 시각을 다시 계산
}
