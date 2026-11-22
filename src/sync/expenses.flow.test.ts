// 경비의 기기 간 동기화(같은 사용자의 폰과 태블릿): 'self' ↔ 사용자 id 변환, 오프라인 등록, 금액·분담 충돌, 같은 정산 결과.
import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { addExpense, deleteExpense, listExpenses, updateExpense } from '../db/expenses'
import { addItem } from '../db/itinerary'
import { addShopping } from '../db/shopping'
import { createTrip } from '../db/trips'
import type { Money } from '../db/types'
import { balances, minTransfers } from '../lib/settle'
import { splitEqual } from '../lib/split'
import { downloadTrip, resolveConflict, SyncNetworkError, syncTrip, type RemoteAdapter } from './engine'
import { makeDevice, type Device } from './testDevice'
import { createTestServer, U, type TestServer } from './testServer'

let s: TestServer
let phone: Device, tablet: Device        // 같은 사용자의 두 기기
let tripId: string, food: string

beforeAll(async () => { s = await createTestServer() })
beforeEach(async () => {
  await s.admin(); await s.pg.exec('truncate trip_members, trips, expenses, expense_categories cascade')
  phone = await makeDevice(s, U.A, 'phone'); tablet = await makeDevice(s, U.A, 'tablet')
  tripId = (await createTrip({ name: '도쿄', country: '일본', city: '도쿄', startDate: '2030-05-10', endDate: '2030-05-12', timeZone: 'Asia/Tokyo', localCurrency: 'JPY' }, phone.db)).id
  await syncTrip(tripId, phone.remote, phone.db)
  await downloadTrip(tripId, tablet.remote, tablet.db)
  food = (await phone.db.expenseCategories.where('tripId').equals(tripId).toArray()).find((c) => c.name === '식비')!.id
})

const mk = (over: Partial<Money> = {}): Money => ({ localMinor: 1000, currency: 'KRW', rateMicro: 1_000_000, homeMinor: 1000, shared: false, payer: 'self', splits: [], ...over })
const sync2 = async () => { for (let i = 0; i < 3; i++) { await syncTrip(tripId, phone.remote, phone.db); await syncTrip(tripId, tablet.remote, tablet.db) } }
const settlement = async (d: Device) => minTransfers(balances((await listExpenses(tripId, d.db)).map((e) => ({ money: e.money }))))

describe('syncing expenses between my devices', () => {
  it("'self' is stored as the signed-in user on the server and shows as 'self' on every device; companions stay as names", async () => {
    const e = await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 9000, homeMinor: 9000, shared: true, payer: 'self', splits: splitEqual(9000, ['self', 'n:민수', 'n:지은'], 'seed') }) }, phone.db)
    await sync2()
    await s.admin()
    const row = (await s.pg.query<{ money: Money; payer_id: string; created_by: string }>(`select money, payer_id, created_by from expenses where id = '${e.id}'`)).rows[0]
    expect(row.money.payer).toBe(U.A); expect(row.payer_id).toBe(U.A); expect(row.created_by).toBe(U.A)
    expect(row.money.splits.map((x) => x.k).sort()).toEqual([U.A, 'n:민수', 'n:지은'].sort())     // 서버에는 'self' 가 없다
    for (const d of [phone, tablet]) {
      const x = (await d.db.expenses.get(e.id))!
      expect(x.money.payer).toBe('self')                                                          // 내 다른 기기에서도 '나'
      expect(x.money.splits.map((y) => y.k).sort()).toEqual(['self', 'n:민수', 'n:지은'].sort())
    }
  })

  it('both devices compute exactly the same settlement from the same shared expenses', async () => {
    await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 30001, homeMinor: 30001, shared: true, payer: 'self', splits: splitEqual(30001, ['self', 'n:민수', 'n:지은'], 'e1') }) }, phone.db)
    await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 12000, homeMinor: 12000, shared: true, payer: 'n:민수', splits: [{ k: 'self', s: 2000 }, { k: 'n:민수', s: 10000 }] }) }, tablet.db)
    await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 5000, homeMinor: 5000, shared: true, payer: 'n:지은', splits: splitEqual(5000, ['self', 'n:지은'], 'e3') }) }, phone.db)
    await sync2()
    const a = await settlement(phone), b = await settlement(tablet)
    expect(a.length).toBeGreaterThan(0)
    expect(b).toEqual(a)
    const bal = balances((await listExpenses(tripId, phone.db)).map((e) => ({ money: e.money })))
    expect(Object.values(bal).reduce((x, y) => x + y, 0)).toBe(0)
  })

  it('personal and shared expenses both reach my other device (it is the same person)', async () => {
    const mine = await addExpense(tripId, { categoryId: food, memo: '개인 지출', money: mk({ localMinor: 4000, homeMinor: 4000 }) }, phone.db)
    const shared = await addExpense(tripId, { categoryId: food, money: mk({ shared: true, payer: 'self', splits: [{ k: 'self', s: 500 }, { k: 'n:민수', s: 500 }] }) }, phone.db)
    await sync2()
    expect((await tablet.db.expenses.toArray()).map((e) => e.id).sort()).toEqual([mine.id, shared.id].sort())
  })

  it('an expense created offline syncs once later, with no duplicate even when the first response is lost', async () => {
    tablet.state.down = true
    const e = await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 2500, homeMinor: 2500, shared: true, payer: 'self', splits: splitEqual(2500, ['self', 'n:민수'], 'off') }) }, tablet.db)
    expect((await syncTrip(tripId, tablet.remote, tablet.db)).error).toMatch(/네트워크/)
    tablet.state.down = false
    let first = true
    const lossy: RemoteAdapter = { ...tablet.remote, push: async (req) => { const r = await tablet.remote.push(req); if (first && req.table === 'expenses') { first = false; throw new SyncNetworkError() } return r } }
    await syncTrip(tripId, lossy, tablet.db)                                                       // 서버에는 반영, 응답 유실
    const r = await syncTrip(tripId, tablet.remote, tablet.db)                                     // 재시도
    expect(r.conflicts).toBe(0)
    await sync2()
    await s.admin(); expect((await s.pg.query(`select 1 from expenses where id = '${e.id}'`)).rows).toHaveLength(1)
    expect((await phone.db.expenses.get(e.id))!.money.payer).toBe('self')
  })

  it('amount and split conflicts are one atomic conflict; resolving it leaves the server consistent either way', async () => {
    const e = await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 10000, homeMinor: 10000, shared: true, payer: 'self', splits: splitEqual(10000, ['self', 'n:민수'], 'c') }) }, phone.db)
    await sync2()
    await updateExpense(e.id, { money: mk({ localMinor: 20000, homeMinor: 20000, shared: true, payer: 'self', splits: splitEqual(20000, ['self', 'n:민수'], 'c') }) }, phone.db)             // 폰: 금액 변경
    await updateExpense(e.id, { money: mk({ localMinor: 10000, homeMinor: 10000, shared: true, payer: 'self', splits: [{ k: 'self', s: 7000 }, { k: 'n:민수', s: 3000 }] }) }, tablet.db) // 태블릿: 분담 변경
    await syncTrip(tripId, phone.remote, phone.db)
    const r = await syncTrip(tripId, tablet.remote, tablet.db)
    expect(r.conflicts).toBe(1)
    const [c] = await tablet.db.conflicts.toArray()
    expect(c.field).toBe('money')
    await s.admin()
    const sv = (await s.pg.query<{ money: Money }>(`select money from expenses where id = '${e.id}'`)).rows[0].money
    expect(sv.homeMinor).toBe(20000); expect(sv.splits.reduce((x, y) => x + y.s, 0)).toBe(20000)   // 서버는 항상 합계가 맞는 상태
    await resolveConflict(c.id, 'mine', tablet.db)
    await sync2()
    await s.admin()
    const fin = (await s.pg.query<{ money: Money }>(`select money from expenses where id = '${e.id}'`)).rows[0].money
    expect(fin.homeMinor).toBe(10000); expect(fin.splits.reduce((x, y) => x + y.s, 0)).toBe(10000)
    for (const d of [phone, tablet]) expect((await d.db.expenses.get(e.id))!.money.homeMinor).toBe(10000)
    expect(await phone.db.conflicts.count()).toBe(0); expect(await tablet.db.conflicts.count()).toBe(0)
  })

  it('different fields still merge: one device edits the memo while the other edits the amount', async () => {
    const e = await addExpense(tripId, { categoryId: food, memo: '', money: mk({ shared: true, payer: 'self', splits: [{ k: 'self', s: 600 }, { k: 'n:민수', s: 400 }] }) }, phone.db)
    await sync2()
    await updateExpense(e.id, { memo: '폰에서 쓴 메모' }, phone.db)
    await updateExpense(e.id, { money: mk({ localMinor: 2000, homeMinor: 2000, shared: true, payer: 'self', splits: [{ k: 'n:민수', s: 1000 }, { k: 'self', s: 1000 }] }) }, tablet.db)
    await sync2()
    for (const d of [phone, tablet]) { const x = (await d.db.expenses.get(e.id))!; expect([x.memo, x.money.homeMinor]).toEqual(['폰에서 쓴 메모', 2000]) }
  })

  it('deleting a shared expense on one device removes it on the other and the settlement updates', async () => {
    const e = await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 8000, homeMinor: 8000, shared: true, payer: 'self', splits: splitEqual(8000, ['self', 'n:민수'], 'd') }) }, phone.db)
    await sync2()
    expect((await settlement(tablet)).length).toBe(1)
    await deleteExpense(e.id, phone.db); await sync2()
    expect(await listExpenses(tripId, tablet.db)).toHaveLength(0)
    expect(await settlement(tablet)).toEqual([])
  })

  it('links to itinerary items and shopping items survive syncing', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '점심' }, phone.db)
    const sh = await addShopping(tripId, { name: '과자' }, phone.db)
    const e = await addExpense(tripId, { categoryId: food, itineraryItemId: it.id, shoppingItemId: sh.id, money: mk({ shared: true, payer: 'self', splits: [{ k: 'self', s: 500 }, { k: 'n:민수', s: 500 }] }) }, phone.db)
    await sync2()
    const onTablet = (await tablet.db.expenses.get(e.id))!
    expect([onTablet.itineraryItemId, onTablet.shoppingItemId]).toEqual([it.id, sh.id])
    await updateExpense(e.id, { memo: '메모 추가' }, phone.db)
    expect((await syncTrip(tripId, phone.remote, phone.db)).error).toBeNull()
    await s.admin(); expect((await s.pg.query<{ memo: string }>(`select memo from expenses where id = '${e.id}'`)).rows[0].memo).toBe('메모 추가')
  })
})
