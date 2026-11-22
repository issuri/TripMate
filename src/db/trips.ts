import { v4 as uuid } from 'uuid'
import { computeStatus, daysBetween, isValidDate } from '../lib/dates'
import { db as defaultDb, type TripMateDB } from './local'
import type { Trip } from './types'

export const DEFAULT_CATEGORIES = ['항공 및 교통', '숙박', '식비', '관광 및 입장료', '쇼핑', '기타']
export const DEFAULT_CHECKLIST = ['여권 확인', '항공권/예약 확인', '환전', '로밍/유심', '충전기/어댑터', '여행자 보험']

export interface NewTripInput {
  name: string
  country: string
  city: string
  startDate: string
  endDate: string
  timeZone?: string
  purpose?: string
  companions?: string[]
  coverImage?: string | null
  localCurrency?: string
  totalBudgetMinor?: number
  ownerId?: string
}

export function validateTrip(i: NewTripInput): string | null {
  if (!i.name.trim()) return '여행 이름을 입력하세요.'
  if (!isValidDate(i.startDate) || !isValidDate(i.endDate)) return '날짜 형식이 올바르지 않습니다.'
  if (i.endDate < i.startDate) return '종료일은 시작일 이후여야 합니다.'
  if (daysBetween(i.startDate, i.endDate) > 120) return '여행 기간은 최대 120일까지 지원합니다.'
  return null
}

/** 여행 + 기본 지출 항목 + 준비 체크리스트를 한 트랜잭션으로 생성. 날짜별 일정(DAY n)은 tripDays()로 파생된다. */
export async function createTrip(input: NewTripInput, db: TripMateDB = defaultDb): Promise<Trip> {
  const err = validateTrip(input)
  if (err) throw new Error(err)
  const now = Date.now()
  const tz = input.timeZone ?? 'Asia/Seoul'
  const meta = { version: 0, updatedAt: now, deletedAt: null, syncState: 'pending' as const }
  const trip: Trip = {
    id: uuid(), ...meta,
    ownerId: input.ownerId ?? 'local',
    name: input.name.trim(), country: input.country.trim(), city: input.city.trim(),
    startDate: input.startDate, endDate: input.endDate, timeZone: tz,
    purpose: input.purpose ?? '', coverImage: input.coverImage ?? null,
    status: computeStatus(input.startDate, input.endDate, tz),
    homeCurrency: 'KRW', localCurrency: input.localCurrency ?? 'KRW',
    totalBudgetMinor: input.totalBudgetMinor ?? 0, shoppingBudgetMinor: 0,
    companions: input.companions ?? [],
  }
  await db.transaction('rw', [db.trips, db.expenseCategories, db.checklistItems, db.outbox], async () => {
    await db.trips.add(trip)
    await db.expenseCategories.bulkAdd(DEFAULT_CATEGORIES.map((name, i) => ({
      id: uuid(), tripId: trip.id, ...meta, name, budgetMinor: 0, sortOrder: i,
    })))
    await db.checklistItems.bulkAdd(DEFAULT_CHECKLIST.map((title, i) => ({
      id: uuid(), tripId: trip.id, ...meta, title, done: false, sortOrder: i,
    })))
    await db.outbox.add({ table: 'trips', recordId: trip.id, op: 'upsert', baseVersion: 0, changedFields: ['*'], createdAt: now })
  })
  return trip
}

/** 삭제는 tombstone(soft delete). 하위 데이터도 함께 표시해 동기화 시 서버에 삭제가 전달된다. */
export async function deleteTrip(id: string, db: TripMateDB = defaultDb) {
  const now = Date.now()
  await db.transaction('rw', db.trips, db.outbox, async () => {
    const t = await db.trips.get(id)
    if (!t) return
    await db.trips.update(id, { deletedAt: now, updatedAt: now, syncState: 'pending' })
    await db.outbox.add({ table: 'trips', recordId: id, op: 'delete', baseVersion: t.version, changedFields: ['deletedAt'], createdAt: now })
  })
}

export const listTrips = (db: TripMateDB = defaultDb) =>
  db.trips.filter((t) => t.deletedAt === null).sortBy('startDate')
