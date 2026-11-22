import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { summarizeBudget, dateIn } from '../lib/budget'
import { convertToHome, parseRateMicro } from '../lib/money'
import { splitEqual } from '../lib/split'
import { addCategory, addExpense, deleteCategory, deleteExpense, listExpenses, rateFromAmounts, recentDefaults, updateCategory, updateExpense, validateMoney } from './expenses'
import { addItem } from './itinerary'
import { TripMateDB } from './local'
import { addShopping } from './shopping'
import { createTrip } from './trips'
import type { Money } from './types'

let db: TripMateDB
let tripId: string
let cats: Record<string, string>
const base: Money = { localMinor: 1000, currency: 'KRW', rateMicro: 1_000_000, homeMinor: 1000, shared: false, payer: 'self', splits: [] }
const mk = (over: Partial<Money> = {}): Money => ({ ...base, ...over })

beforeEach(async () => {
  db = new TripMateDB('x-' + Math.random()); await db.open()
  tripId = (await createTrip({ name: '도쿄', country: '일본', city: '도쿄', startDate: '2030-05-10', endDate: '2030-05-12', timeZone: 'Asia/Tokyo', localCurrency: 'JPY' }, db)).id
  cats = Object.fromEntries((await db.expenseCategories.where('tripId').equals(tripId).toArray()).map((c) => [c.name, c.id]))
})

describe('addExpense', () => {
  it('stores a personal expense with exact integers, queues it for sync, and keeps local and home amounts separate', async () => {
    const e = await addExpense(tripId, { categoryId: cats['식비'], paymentMethod: ' 현금 ', memo: ' 점심 ', money: mk({ localMinor: 1500, currency: 'JPY', rateMicro: parseRateMicro('9.1234')!, homeMinor: convertToHome(1500, 'JPY', parseRateMicro('9.1234')!) }) }, db)
    expect(e.money).toMatchObject({ localMinor: 1500, currency: 'JPY', homeMinor: 13685, rateMicro: 9_123_400, shared: false, splits: [] })
    expect([e.paymentMethod, e.memo, e.syncState, e.version]).toEqual(['현금', '점심', 'pending', 0])
    const q = (await db.outbox.toArray()).filter((x) => x.recordId === e.id)
    expect(q).toHaveLength(1); expect(q[0]).toMatchObject({ table: 'expenses', op: 'upsert', changedFields: ['*'] })
  })
  it('stores a shared expense with an exact split and drops splits for personal ones', async () => {
    const splits = splitEqual(10000, ['self', 'a', 'b'], 'seed')
    const e = await addExpense(tripId, { categoryId: cats['식비'], money: mk({ localMinor: 10000, homeMinor: 10000, shared: true, splits }) }, db)
    expect(e.money.splits.reduce((a, x) => a + x.s, 0)).toBe(10000)
    await expect(addExpense(tripId, { categoryId: cats['식비'], money: mk({ splits }) }, db)).rejects.toThrow(/개인 경비/)
  })
  it('rejects bad amounts, rates, currencies, missing payers and mismatching splits with readable messages', async () => {
    const t = (m: Money) => addExpense(tripId, { categoryId: cats['식비'], money: m }, db)
    await expect(t(mk({ localMinor: 0 }))).rejects.toThrow(/0보다/)
    await expect(t(mk({ localMinor: -5 }))).rejects.toThrow()
    await expect(t(mk({ localMinor: 1.5 }))).rejects.toThrow()
    await expect(t(mk({ localMinor: NaN }))).rejects.toThrow()
    await expect(t(mk({ homeMinor: -1 }))).rejects.toThrow(/환산/)
    await expect(t(mk({ rateMicro: 0 }))).rejects.toThrow(/환율/)
    await expect(t(mk({ currency: 'jpy' }))).rejects.toThrow(/통화/)
    await expect(t(mk({ shared: true, payer: null, splits: [{ k: 'a', s: 1000 }] }))).rejects.toThrow(/결제한 사람/)
    await expect(t(mk({ shared: true, splits: [] }))).rejects.toThrow(/참여자/)
    await expect(t(mk({ shared: true, splits: [{ k: 'a', s: 400 }, { k: 'b', s: 500 }] }))).rejects.toThrow(/100원 부족/)
    expect(await db.expenses.count()).toBe(0)
    expect(validateMoney(mk())).toBeNull()
  })
  it('rejects categories/links that do not belong to this trip or are deleted, and oversized text', async () => {
    const other = (await createTrip({ name: '다른', country: '', city: '', startDate: '2030-06-01', endDate: '2030-06-02' }, db)).id
    const otherCat = (await db.expenseCategories.where('tripId').equals(other).toArray())[0].id
    await expect(addExpense(tripId, { categoryId: otherCat, money: mk() }, db)).rejects.toThrow(/항목/)
    await expect(addExpense(tripId, { categoryId: 'nope', money: mk() }, db)).rejects.toThrow(/항목/)
    const otherItem = await addItem(other, { dayNumber: 1, kind: 'meal', title: 'x' }, db)
    await expect(addExpense(tripId, { categoryId: cats['식비'], itineraryItemId: otherItem.id, money: mk() }, db)).rejects.toThrow(/일정/)
    await expect(addExpense(tripId, { categoryId: cats['식비'], memo: 'x'.repeat(1001), money: mk() }, db)).rejects.toThrow(/글자/)
    await expect(addExpense(tripId, { categoryId: cats['식비'], paymentMethod: 'x'.repeat(41), money: mk() }, db)).rejects.toThrow(/글자/)
  })
  it('links to an itinerary item and a shopping item of the same trip', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '점심' }, db)
    const sh = await addShopping(tripId, { name: '과자' }, db)
    const e = await addExpense(tripId, { categoryId: cats['식비'], itineraryItemId: it.id, shoppingItemId: sh.id, money: mk() }, db)
    expect([e.itineraryItemId, e.shoppingItemId]).toEqual([it.id, sh.id])
  })
})

describe('updateExpense / deleteExpense', () => {
  it('records only changed fields, treats the money block as one unit, and no-op saves queue nothing', async () => {
    const e = await addExpense(tripId, { categoryId: cats['식비'], memo: '메모', money: mk() }, db)
    await db.outbox.clear()
    await updateExpense(e.id, { memo: '메모', money: mk() }, db)
    expect(await db.outbox.count()).toBe(0)
    await updateExpense(e.id, { memo: '새 메모' }, db)
    expect((await db.outbox.toArray())[0].changedFields).toEqual(['memo'])
    await db.outbox.clear()
    await updateExpense(e.id, { money: mk({ localMinor: 2000, homeMinor: 2000 }) }, db)
    expect((await db.outbox.toArray())[0].changedFields).toEqual(['money'])
    expect((await db.expenses.get(e.id))!.money.homeMinor).toBe(2000)
  })
  it('refuses an update that would make the split inconsistent and leaves the data unchanged', async () => {
    const e = await addExpense(tripId, { categoryId: cats['식비'], money: mk({ shared: true, splits: [{ k: 'self', s: 600 }, { k: 'a', s: 400 }] }) }, db)
    await expect(updateExpense(e.id, { money: mk({ localMinor: 2000, homeMinor: 2000, shared: true, splits: [{ k: 'self', s: 600 }, { k: 'a', s: 400 }] }) }, db)).rejects.toThrow(/부족/)
    expect((await db.expenses.get(e.id))!.money.homeMinor).toBe(1000)
  })
  it('an already-synced shared expense cannot become personal (a never-synced one still can)', async () => {
    const e = await addExpense(tripId, { categoryId: cats['식비'], money: mk({ shared: true, splits: [{ k: 'self', s: 1000 }] }) }, db)
    await updateExpense(e.id, { money: mk() }, db)                                         // 아직 아무에게도 보인 적 없으므로 가능
    const f = await addExpense(tripId, { categoryId: cats['식비'], money: mk({ shared: true, splits: [{ k: 'self', s: 1000 }] }) }, db)
    await db.expenses.update(f.id, { version: 3, syncState: 'synced' })                    // 서버에 올라간 상태를 흉내
    await expect(updateExpense(f.id, { money: mk() }, db)).rejects.toThrow(/개인 경비로 바꿀 수 없어요/)
    expect((await db.expenses.get(f.id))!.money.shared).toBe(true)
    await updateExpense(f.id, { money: mk({ localMinor: 2000, homeMinor: 2000, shared: true, splits: [{ k: 'self', s: 2000 }] }) }, db)   // 공동 경비를 고치는 것은 가능
  })
  it('delete is a tombstone: hidden from lists, queued as a delete, and a deleted expense cannot be edited back to life', async () => {
    const e = await addExpense(tripId, { categoryId: cats['식비'], money: mk() }, db)
    await deleteExpense(e.id, db)
    expect(await listExpenses(tripId, db)).toHaveLength(0)
    expect((await db.outbox.toArray()).some((x) => x.recordId === e.id && x.op === 'delete')).toBe(true)
    await expect(updateExpense(e.id, { memo: 'x' }, db)).rejects.toThrow(/찾을 수/)
    await deleteExpense(e.id, db)   // 두 번 지워도 안전
  })
  it('lists newest first', async () => {
    const a = await addExpense(tripId, { categoryId: cats['식비'], paidAt: 1000, money: mk() }, db)
    const b = await addExpense(tripId, { categoryId: cats['식비'], paidAt: 3000, money: mk() }, db)
    expect((await listExpenses(tripId, db)).map((x) => x.id)).toEqual([b.id, a.id])
  })
})

describe('categories', () => {
  it('adds, renames, sets budgets, forbids duplicates and bad values', async () => {
    const c = await addCategory(tripId, '  카페  ', 50000, db)
    expect([c.name, c.budgetMinor]).toEqual(['카페', 50000])
    await expect(addCategory(tripId, '카페', 0, db)).rejects.toThrow(/이미/)
    await expect(addCategory(tripId, ' ', 0, db)).rejects.toThrow(/이름/)
    await expect(addCategory(tripId, 'x'.repeat(41), 0, db)).rejects.toThrow(/글자/)
    await expect(addCategory(tripId, '음수', -1, db)).rejects.toThrow(/예산/)
    await updateCategory(c.id, { name: '커피', budgetMinor: 70000 }, db)
    expect(await db.expenseCategories.get(c.id)).toMatchObject({ name: '커피', budgetMinor: 70000 })
    await expect(updateCategory(c.id, { name: '식비' }, db)).rejects.toThrow(/이미/)
    await db.outbox.clear(); await updateCategory(c.id, { name: '커피', budgetMinor: 70000 }, db); expect(await db.outbox.count()).toBe(0)
  })
  it('refuses to delete a category that still has expenses, allows it after they are gone', async () => {
    const c = await addCategory(tripId, '임시', 0, db)
    const e = await addExpense(tripId, { categoryId: c.id, money: mk() }, db)
    await expect(deleteCategory(c.id, db)).rejects.toThrow(/1건/)
    await deleteExpense(e.id, db); await deleteCategory(c.id, db)
    expect((await db.expenseCategories.get(c.id))!.deletedAt).not.toBeNull()
    await expect(addExpense(tripId, { categoryId: c.id, money: mk() }, db)).rejects.toThrow(/항목/)
  })
})

describe('defaults and exchange rates', () => {
  it('remembers the latest category, payment methods, currency and per-currency rates', async () => {
    await addExpense(tripId, { categoryId: cats['식비'], paymentMethod: '현금', paidAt: 1000, money: mk({ currency: 'JPY', rateMicro: 9_000_000 }) }, db)
    await addExpense(tripId, { categoryId: cats['쇼핑'], paymentMethod: '카드', paidAt: 2000, money: mk({ currency: 'USD', rateMicro: 1_380_000_000, localMinor: 100, homeMinor: 1380 }) }, db)
    const d = await recentDefaults(tripId, db)
    expect(d).toMatchObject({ categoryId: cats['쇼핑'], paymentMethod: '카드', currency: 'USD', methods: ['카드', '현금'] })
    expect(d.rates).toEqual({ USD: 1_380_000_000, JPY: 9_000_000 })
  })
  it('derives the rate from a manually entered won amount and converts back within a won', () => {
    let seed = 3
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 300; i++) {
      const cur = ['JPY', 'USD', 'EUR', 'KRW'][i % 4]
      const local = 1 + Math.floor(rnd() * 5_000_000), home = 1 + Math.floor(rnd() * 8_000_000)
      const r = rateFromAmounts(local, cur, home)!
      expect(r).toBeGreaterThan(0)
      if (home / local > 1e-5) expect(Math.abs(convertToHome(local, cur, r) - home)).toBeLessThanOrEqual(Math.max(1, Math.ceil(local / 1e6 * 2)))
    }
    expect(rateFromAmounts(0, 'JPY', 100)).toBeNull(); expect(rateFromAmounts(100, 'JPY', -1)).toBeNull()
    expect(rateFromAmounts(1000, 'JPY', 9123)).toBe(9_123_000)       // 1000엔 = 9,123원 → 9.123
    expect(rateFromAmounts(1234, 'USD', 17035)).toBe(1_380_470_016)          // 12.34달러 = 17,035원 → 1380.470016
  })
})

describe('budget summary', () => {
  const mkE = (id: string, categoryId: string, paidAt: number, m: Partial<Money> = {}, deleted = false) => ({ id, tripId: 't', version: 1, updatedAt: 0, deletedAt: deleted ? 1 : null, syncState: 'synced' as const, categoryId, paidAt, paymentMethod: '', itineraryItemId: null, shoppingItemId: null, memo: '', money: mk(m) })
  const mkC = (id: string, name: string, budgetMinor: number, sortOrder: number, deleted = false) => ({ id, tripId: 't', version: 1, updatedAt: 0, deletedAt: deleted ? 1 : null, syncState: 'synced' as const, name, budgetMinor, sortOrder })

  it('totals, remaining, usage, over-budget, today, top category and shared/personal split', () => {
    const NOW = Date.UTC(2030, 4, 10, 3, 0)  // 도쿄 5/10 12:00
    const s = summarizeBudget({
      totalBudgetMinor: 100000, timeZone: 'Asia/Tokyo', now: NOW,
      categories: [mkC('f', '식비', 30000, 0), mkC('s', '쇼핑', 0, 1), mkC('d', '지움', 0, 2, true)],
      expenses: [
        mkE('1', 'f', NOW, { homeMinor: 20000 }), mkE('2', 'f', NOW - 86400000, { homeMinor: 15000, shared: true, splits: [{ k: 'self', s: 15000 }] }),
        mkE('3', 's', NOW, { homeMinor: 50000 }), mkE('4', 's', NOW, { homeMinor: 99999 }, true), mkE('5', 'd', NOW, { homeMinor: 1000 }),
      ],
    })
    expect(s).toMatchObject({ spentMinor: 86000, remainingMinor: 14000, usedPct: 86, overBudget: false, todayMinor: 71000, sharedMinor: 15000, personalMinor: 71000, count: 4 })
    expect(s.byCategory.map((c) => [c.name, c.spentMinor, c.over])).toEqual([['식비', 35000, true], ['쇼핑', 50000, false], ['삭제된 항목', 1000, false]])
    expect(s.byCategory[0].pct).toBe(117); expect(s.byCategory[1].pct).toBeNull()
    expect(s.topCategory!.name).toBe('쇼핑')
    expect(s.byDay).toEqual([{ date: '2030-05-09', totalMinor: 15000 }, { date: '2030-05-10', totalMinor: 71000 }])
  })
  it('flags overspending and handles "no budget" and "no expenses"', () => {
    const e = [mkE('1', 'f', 0, { homeMinor: 120000 })]
    const over = summarizeBudget({ totalBudgetMinor: 100000, categories: [mkC('f', '식비', 0, 0)], expenses: e, timeZone: 'Asia/Seoul' })
    expect([over.overBudget, over.overByMinor, over.remainingMinor, over.usedPct]).toEqual([true, 20000, -20000, 120])
    const none = summarizeBudget({ totalBudgetMinor: 0, categories: [], expenses: [], timeZone: 'Asia/Seoul' })
    expect([none.usedPct, none.overBudget, none.spentMinor, none.topCategory, none.byDay]).toEqual([null, false, 0, null, []])
  })
  it('groups by the destination date, not the device date, around midnight', () => {
    expect(dateIn(Date.UTC(2030, 4, 9, 15, 30), 'Asia/Tokyo')).toBe('2030-05-10')   // 도쿄 00:30
    expect(dateIn(Date.UTC(2030, 4, 9, 15, 30), 'America/Los_Angeles')).toBe('2030-05-09')
  })
})
