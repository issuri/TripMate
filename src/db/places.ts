import { v4 as uuid } from 'uuid'
import { db as defaultDb, type TripMateDB } from './local'
import { logChange, pending } from './sync'
import type { Place } from './types'

export interface PlaceInput {
  name: string
  address?: string
  lat?: number | null
  lng?: number | null
  externalId?: string | null
  category?: string
}

/** 위도·경도는 둘 다 있거나 둘 다 없어야 하고, 유한한 숫자이며 범위 안이어야 한다. */
export const validCoord = (lat: number | null | undefined, lng: number | null | undefined) => {
  if (lat == null && lng == null) return true
  if (lat == null || lng == null) return false
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

/** 같은 외부 장소(또는 같은 이름+좌표)는 새로 만들지 않고 기존 장소를 돌려준다(중복 저장 방지). */
export async function addPlace(tripId: string, input: PlaceInput, db: TripMateDB = defaultDb): Promise<Place> {
  if (!input.name.trim()) throw new Error('장소 이름을 입력하세요.')
  if (input.name.length > 200 || (input.address?.length ?? 0) > 500) throw new Error('입력한 글자 수가 너무 많습니다.')
  if (!validCoord(input.lat, input.lng)) throw new Error('위도와 경도를 함께, 올바른 범위로 입력하세요.')
  const existing = await db.places.where('tripId').equals(tripId).filter((p) => p.deletedAt === null).toArray()
  const dup = existing.find((p) =>
    (input.externalId && p.externalId === input.externalId) ||
    (!input.externalId && p.name === input.name.trim() && p.lat === (input.lat ?? null) && p.lng === (input.lng ?? null)))
  if (dup) return dup
  const place: Place = {
    id: uuid(), tripId, version: 0, deletedAt: null, ...pending(),
    name: input.name.trim(), address: input.address ?? '', lat: input.lat ?? null, lng: input.lng ?? null,
    externalId: input.externalId ?? null, category: input.category ?? 'sight',
  }
  await db.transaction('rw', db.places, db.outbox, async () => {
    await db.places.add(place)
    await logChange(db, 'places', place.id, 'upsert', 0, ['*'])
  })
  return place
}

/** 장소 삭제: tombstone 처리하고, 이 장소를 쓰던 일정/쇼핑은 연결만 끊는다(일정 자체는 유지). */
export async function deletePlace(id: string, db: TripMateDB = defaultDb) {
  await db.transaction('rw', [db.places, db.itineraryItems, db.shoppingItems, db.outbox], async () => {
    const p = await db.places.get(id)
    if (!p || p.deletedAt !== null) return
    await db.places.update(id, { deletedAt: Date.now(), ...pending() })
    await logChange(db, 'places', id, 'delete', p.version, ['deletedAt'])
    // 이미 삭제된 일정/상품은 건드리지 않는다: 삭제된 레코드에 수정 기록이 생기면 동기화 때 서버에 되살아날 수 있다
    for (const it of await db.itineraryItems.where('tripId').equals(p.tripId).filter((i) => i.deletedAt === null && i.placeId === id).toArray()) {
      await db.itineraryItems.update(it.id, { placeId: null, locationText: it.locationText || p.name, ...pending() })
      await logChange(db, 'itinerary_items', it.id, 'upsert', it.version, ['placeId', 'locationText'])
    }
    for (const s of await db.shoppingItems.where('tripId').equals(p.tripId).filter((i) => i.deletedAt === null && i.storePlaceId === id).toArray()) {
      await db.shoppingItems.update(s.id, { storePlaceId: null, ...pending() })
      await logChange(db, 'shopping_items', s.id, 'upsert', s.version, ['storePlaceId'])
    }
  })
}

export const listPlaces = (tripId: string, db: TripMateDB = defaultDb) =>
  db.places.where('tripId').equals(tripId).filter((p) => p.deletedAt === null).toArray()
