import { v4 as uuid } from 'uuid'
import { changedFields } from '../lib/diff'
import { minorDigits } from '../lib/money'
import { validateSplits } from '../lib/split'
import { db as defaultDb, type TripMateDB } from './local'
import { logChange, pending } from './sync'
import type { Expense, ExpenseCategory, Money } from './types'

export interface ExpenseInput {
  categoryId: string
  paidAt?: number
  paymentMethod?: string
  itineraryItemId?: string | null
  shoppingItemId?: string | null
  memo?: string
  money: Money
}

const SAFE = Number.MAX_SAFE_INTEGER

/** 금액 덩어리 검증. 문제가 있으면 사용자에게 보여줄 메시지, 없으면 null. */
export function validateMoney(m: Money): string | null {
  const isInt = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n)
  if (!isInt(m.localMinor) || m.localMinor <= 0) return '금액을 0보다 크게 입력하세요.'
  if (!isInt(m.homeMinor) || m.homeMinor < 0 || m.homeMinor > SAFE) return '원화 환산 금액이 올바르지 않아요.'
  if (!isInt(m.rateMicro) || m.rateMicro <= 0) return '환율은 0보다 커야 해요.'
  if (!/^[A-Z]{3}$/.test(m.currency)) return '통화 코드가 올바르지 않아요.'
  if (m.shared) {
    if (!m.payer) return '공동 경비는 결제한 사람을 선택하세요.'
    return validateSplits(m.homeMinor, m.splits)
  }
  if (m.splits.length > 0) return '개인 경비에는 부담 금액을 나눌 수 없어요.'
  return null
}

async function checkLinks(db: TripMateDB, tripId: string, categoryId: string, itineraryItemId?: string | null, shoppingItemId?: string | null) {
  const cat = await db.expenseCategories.get(categoryId)
  if (!cat || cat.tripId !== tripId || cat.deletedAt !== null) throw new Error('지출 항목을 선택하세요.')
  if (itineraryItemId) { const i = await db.itineraryItems.get(itineraryItemId); if (!i || i.tripId !== tripId || i.deletedAt !== null) throw new Error('연결한 일정을 찾을 수 없어요.') }
  if (shoppingItemId) { const s = await db.shoppingItems.get(shoppingItemId); if (!s || s.tripId !== tripId || s.deletedAt !== null) throw new Error('연결한 쇼핑 상품을 찾을 수 없어요.') }
}

function checkText(i: { memo?: string; paymentMethod?: string }) {
  if ((i.memo?.length ?? 0) > 1000 || (i.paymentMethod?.length ?? 0) > 40) throw new Error('입력한 글자 수가 너무 많아요.')
}

/** 지출 등록. id 는 클라이언트가 만든 UUID라서 오프라인에서 만들고 나중에 올려도 중복되지 않는다. */
export async function addExpense(tripId: string, input: ExpenseInput, db: TripMateDB = defaultDb): Promise<Expense> {
  const err = validateMoney(input.money)
  if (err) throw new Error(err)
  checkText(input)
  await checkLinks(db, tripId, input.categoryId, input.itineraryItemId, input.shoppingItemId)
  const e: Expense = {
    id: uuid(), tripId, version: 0, deletedAt: null, ...pending(),
    categoryId: input.categoryId, paidAt: input.paidAt ?? Date.now(), paymentMethod: (input.paymentMethod ?? '').trim(),
    itineraryItemId: input.itineraryItemId ?? null, shoppingItemId: input.shoppingItemId ?? null, memo: (input.memo ?? '').trim(),
    money: { ...input.money, splits: input.money.shared ? input.money.splits.map((s) => ({ k: s.k, s: s.s })) : [] },
  }
  await db.transaction('rw', db.expenses, db.outbox, async () => {
    await db.expenses.add(e)
    await logChange(db, 'expenses', e.id, 'upsert', 0, ['*'])
  })
  return e
}

/** 지출 수정. 바뀐 필드만 저장·기록한다(money 는 금액·환율·결제자·분담을 한 덩어리로 바꾼다). */
export async function updateExpense(id: string, patch: Partial<ExpenseInput>, db: TripMateDB = defaultDb) {
  await db.transaction('rw', [db.expenses, db.expenseCategories, db.itineraryItems, db.shoppingItems, db.outbox], async () => {
    const cur = await db.expenses.get(id)
    if (!cur || cur.deletedAt !== null) throw new Error('지출을 찾을 수 없어요. 다른 사용자가 삭제했을 수 있어요.')
    const norm: Partial<ExpenseInput> = { ...patch }
    if (norm.money) norm.money = { ...norm.money, splits: norm.money.shared ? norm.money.splits.map((s) => ({ k: s.k, s: s.s })) : [] }
    if (norm.memo !== undefined) norm.memo = norm.memo.trim()
    if (norm.paymentMethod !== undefined) norm.paymentMethod = norm.paymentMethod.trim()
    const diff = changedFields(cur as unknown as Record<string, unknown>, norm as Record<string, unknown>) as Partial<Expense>
    const next = { ...cur, ...diff }
    const err = validateMoney(next.money)
    if (err) throw new Error(err)
    // 이미 서버에 올라가 다른 사람에게 보일 수 있는 공동 경비는 개인 경비로 바꿀 수 없다(서버도 거부한다). 삭제 후 다시 등록한다.
    if (cur.money.shared && !next.money.shared && cur.version > 0) throw new Error('이미 서버에 올린 공동 경비는 개인 경비로 바꿀 수 없어요. 삭제한 뒤 개인 경비로 다시 등록하세요.')
    checkText(next)
    if (Object.keys(diff).length === 0) return
    if (diff.categoryId || diff.itineraryItemId || diff.shoppingItemId) await checkLinks(db, cur.tripId, next.categoryId, next.itineraryItemId, next.shoppingItemId)
    await db.expenses.update(id, { ...diff, ...pending() })
    await logChange(db, 'expenses', id, 'upsert', cur.version, Object.keys(diff))
  })
}

export async function deleteExpense(id: string, db: TripMateDB = defaultDb) {
  await db.transaction('rw', db.expenses, db.outbox, async () => {
    const cur = await db.expenses.get(id)
    if (!cur || cur.deletedAt !== null) return
    await db.expenses.update(id, { deletedAt: Date.now(), ...pending() })
    await logChange(db, 'expenses', id, 'delete', cur.version, ['deletedAt'])
  })
}

export const listExpenses = async (tripId: string, db: TripMateDB = defaultDb) =>
  (await db.expenses.where('tripId').equals(tripId).filter((e) => e.deletedAt === null).toArray()).sort((a, b) => b.paidAt - a.paidAt)

// ───────── 지출 항목(카테고리) ─────────
export async function addCategory(tripId: string, name: string, budgetMinor = 0, db: TripMateDB = defaultDb): Promise<ExpenseCategory> {
  const n = name.trim()
  if (!n) throw new Error('항목 이름을 입력하세요.')
  if (n.length > 40) throw new Error('입력한 글자 수가 너무 많아요.')
  if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0) throw new Error('예산 금액이 올바르지 않아요.')
  const all = await db.expenseCategories.where('tripId').equals(tripId).filter((c) => c.deletedAt === null).toArray()
  if (all.some((c) => c.name === n)) throw new Error('같은 이름의 항목이 이미 있어요.')
  const c: ExpenseCategory = { id: uuid(), tripId, version: 0, deletedAt: null, ...pending(), name: n, budgetMinor, sortOrder: Math.max(-1, ...all.map((x) => x.sortOrder)) + 1 }
  await db.transaction('rw', db.expenseCategories, db.outbox, async () => {
    await db.expenseCategories.add(c)
    await logChange(db, 'expense_categories', c.id, 'upsert', 0, ['*'])
  })
  return c
}

export async function updateCategory(id: string, patch: { name?: string; budgetMinor?: number }, db: TripMateDB = defaultDb) {
  await db.transaction('rw', db.expenseCategories, db.outbox, async () => {
    const cur = await db.expenseCategories.get(id)
    if (!cur || cur.deletedAt !== null) throw new Error('항목을 찾을 수 없어요.')
    const next = { ...patch }
    if (next.name !== undefined) {
      next.name = next.name.trim()
      if (!next.name) throw new Error('항목 이름을 입력하세요.')
      if (next.name.length > 40) throw new Error('입력한 글자 수가 너무 많아요.')
      const dup = await db.expenseCategories.where('tripId').equals(cur.tripId).filter((c) => c.deletedAt === null && c.id !== id && c.name === next.name).count()
      if (dup) throw new Error('같은 이름의 항목이 이미 있어요.')
    }
    if (next.budgetMinor !== undefined && (!Number.isSafeInteger(next.budgetMinor) || next.budgetMinor < 0)) throw new Error('예산 금액이 올바르지 않아요.')
    const diff = changedFields(cur as unknown as Record<string, unknown>, next as Record<string, unknown>)
    if (!Object.keys(diff).length) return
    await db.expenseCategories.update(id, { ...diff, ...pending() })
    await logChange(db, 'expense_categories', id, 'upsert', cur.version, Object.keys(diff))
  })
}

/** 지출이 남아 있는 항목은 지우지 않는다(합계에서 사라지지 않도록). 다른 항목으로 옮긴 뒤 지울 수 있다. */
export async function deleteCategory(id: string, db: TripMateDB = defaultDb) {
  await db.transaction('rw', [db.expenseCategories, db.expenses, db.outbox], async () => {
    const cur = await db.expenseCategories.get(id)
    if (!cur || cur.deletedAt !== null) return
    const used = await db.expenses.where('tripId').equals(cur.tripId).filter((e) => e.deletedAt === null && e.categoryId === id).count()
    if (used > 0) throw new Error(`이 항목에 지출이 ${used}건 있어요. 다른 항목으로 옮기거나 지출을 지운 뒤에 삭제하세요.`)
    await db.expenseCategories.update(id, { deletedAt: Date.now(), ...pending() })
    await logChange(db, 'expense_categories', id, 'delete', cur.version, ['deletedAt'])
  })
}

// ───────── 입력 기본값 ─────────
/** 최근 사용한 항목·결제 수단·통화·환율을 기본값으로 쓴다(입력 단계를 줄이기 위해) */
export async function recentDefaults(tripId: string, db: TripMateDB = defaultDb) {
  const list = await listExpenses(tripId, db)
  const methods: string[] = []
  for (const e of list) if (e.paymentMethod && !methods.includes(e.paymentMethod)) methods.push(e.paymentMethod)
  const rates: Record<string, number> = {}
  for (const e of list) if (!(e.money.currency in rates)) rates[e.money.currency] = e.money.rateMicro
  return { categoryId: list[0]?.categoryId ?? null, paymentMethod: list[0]?.paymentMethod ?? '', methods: methods.slice(0, 5), rates, currency: list[0]?.money.currency ?? null }
}

/** 원화 금액을 직접 입력했을 때의 환율(micro). 환율 = 원화 / 현지금액 */
export function rateFromAmounts(localMinor: number, currency: string, homeMinor: number, homeCurrency = 'KRW'): number | null {
  if (localMinor <= 0 || homeMinor < 0) return null
  const ld = BigInt(minorDigits(currency)), hd = BigInt(minorDigits(homeCurrency))
  // rate(원/현지 단위) = (home / 10^hd) / (local / 10^ld) ;  micro = × 1e6
  const num = BigInt(homeMinor) * 10n ** ld * 1_000_000n
  const den = BigInt(localMinor) * 10n ** hd
  const r = Number((num * 2n + den) / (den * 2n))
  return r > 0 ? r : null
}
