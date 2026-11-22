import { v4 as uuid } from 'uuid'
import { db as defaultDb, type TripMateDB } from './local'
import { logChange, pending } from './sync'
import type { ShoppingItem } from './types'

export interface ShoppingInput {
  name: string
  quantity?: number
  expectedPriceMinor?: number
  storePlaceId?: string | null
  itineraryItemId?: string | null
  memo?: string
  currency?: string
}

function check(i: Partial<ShoppingInput>) {
  if (i.name !== undefined && !i.name.trim()) throw new Error('상품명을 입력하세요.')
  if (i.quantity !== undefined && (!Number.isInteger(i.quantity) || i.quantity < 1)) throw new Error('수량은 1 이상이어야 합니다.')
  if (i.expectedPriceMinor !== undefined && (!Number.isInteger(i.expectedPriceMinor) || i.expectedPriceMinor < 0)) throw new Error('가격이 올바르지 않습니다.')
}

export async function addShopping(tripId: string, input: ShoppingInput, db: TripMateDB = defaultDb): Promise<ShoppingItem> {
  check(input)
  const item: ShoppingItem = {
    id: uuid(), tripId, version: 0, deletedAt: null, ...pending(),
    name: input.name.trim(), quantity: input.quantity ?? 1, expectedPriceMinor: input.expectedPriceMinor ?? 0, actualPriceMinor: null,
    currency: input.currency ?? 'KRW', storePlaceId: input.storePlaceId ?? null, itineraryItemId: input.itineraryItemId ?? null,
    purchased: false, expenseId: null, memo: input.memo ?? '',
  }
  await db.transaction('rw', db.shoppingItems, db.outbox, async () => {
    await db.shoppingItems.add(item)
    await logChange(db, 'shopping_items', item.id, 'upsert', 0, ['*'])
  })
  return item
}

export async function updateShopping(id: string, patch: Partial<ShoppingInput>, db: TripMateDB = defaultDb) {
  check(patch)
  await db.transaction('rw', db.shoppingItems, db.outbox, async () => {
    const cur = await db.shoppingItems.get(id)
    if (!cur || cur.deletedAt !== null) throw new Error('상품을 찾을 수 없습니다. 다른 사용자가 삭제했을 수 있습니다.')
    const changes = { ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) }
    await db.shoppingItems.update(id, { ...changes, ...pending() })
    await logChange(db, 'shopping_items', id, 'upsert', cur.version, Object.keys(changes))
  })
}

/**
 * 구매 완료 체크. 실제 결제 금액은 사용자가 입력한 값만 저장한다.
 * 예상 가격을 실제 금액/지출로 복사하지 않는다. (지출 기록은 7단계에서 사용자 확인 후 생성)
 * 체크만 바뀌는 변경이므로 다른 동행자의 이름/가격 수정과 충돌하지 않는다(필드 단위 변경 기록).
 */
export async function setPurchased(id: string, purchased: boolean, actualPriceMinor?: number | null, db: TripMateDB = defaultDb) {
  if (actualPriceMinor != null && (!Number.isInteger(actualPriceMinor) || actualPriceMinor < 0)) throw new Error('실제 금액이 올바르지 않습니다.')
  await db.transaction('rw', db.shoppingItems, db.outbox, async () => {
    const cur = await db.shoppingItems.get(id)
    if (!cur || cur.deletedAt !== null) return
    const patch: Partial<ShoppingItem> = { purchased }
    if (!purchased) patch.actualPriceMinor = null
    else if (actualPriceMinor !== undefined) patch.actualPriceMinor = actualPriceMinor
    await db.shoppingItems.update(id, { ...patch, ...pending() })
    await logChange(db, 'shopping_items', id, 'upsert', cur.version, Object.keys(patch))
  })
}

export async function deleteShopping(id: string, db: TripMateDB = defaultDb) {
  await db.transaction('rw', db.shoppingItems, db.outbox, async () => {
    const cur = await db.shoppingItems.get(id)
    if (!cur || cur.deletedAt !== null) return
    await db.shoppingItems.update(id, { deletedAt: Date.now(), ...pending() })
    await logChange(db, 'shopping_items', id, 'delete', cur.version, ['deletedAt'])
  })
}

export const listShopping = (tripId: string, db: TripMateDB = defaultDb) =>
  db.shoppingItems.where('tripId').equals(tripId).filter((s) => s.deletedAt === null).toArray()
