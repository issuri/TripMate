// 경비의 기기 간 동기화: 'self' ↔ 사용자 id 변환, 개인 경비 비공개, 오프라인 등록, 금액·분담 충돌, 같은 정산 결과.
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
import { refreshMembers } from './sharing'
import { makeDevice, type Device } from './testDevice'
import { createTestServer, U, type TestServer } from './testServer'

let s: TestServer
let A: Device, B: Device
let tripId: string, food: string

beforeAll(async () => { s = await createTestServer() })
beforeEach(async () => {
  await s.admin(); await s.pg.exec('truncate trip_members, trip_invites, join_attempts, trips, profiles, expenses, expense_categories cascade')
  A = await makeDevice(s, U.A, 'A'); B = await makeDevice(s, U.B, 'B')
  tripId = (await createTrip({ name: '도쿄', country: '일본', city: '도쿄', startDate: '2030-05-10', endDate: '2030-05-12', timeZone: 'Asia/Tokyo', localCurrency: 'JPY' }, A.db)).id
  await syncTrip(tripId, A.remote, A.db)
  await B.api.join(await A.api.createInvite(tripId))
  await downloadTrip(tripId, B.remote, B.db); await refreshMembers(tripId, B.api, B.db); await refreshMembers(tripId, A.api, A.db)
  food = (await A.db.expenseCategories.where('tripId').equals(tripId).toArray()).find((c) => c.name === '식비')!.id
})

const mk = (over: Partial<Money> = {}): Money => ({ localMinor: 1000, currency: 'KRW', rateMicro: 1_000_000, homeMinor: 1000, shared: false, payer: 'self', splits: [], ...over })
const sync2 = async () => { for (let i = 0; i < 3; i++) { await syncTrip(tripId, A.remote, A.db); await syncTrip(tripId, B.remote, B.db) } }
/** 기기별로 달라지는 'self' 를 사용자 id 로 통일해서 두 기기의 결과를 비교한다 */
const canon = (d: Device, m: Money): Money => ({ ...m, payer: m.payer === 'self' ? d.uid : m.payer, splits: m.splits.map((x) => ({ k: x.k === 'self' ? d.uid : x.k, s: x.s })) })
const settlement = async (d: Device) => minTransfers(balances((await listExpenses(tripId, d.db)).map((e) => ({ money: canon(d, e.money) }))))

describe('syncing expenses between companions', () => {
  it("'self' is translated to the signed-in user on the server and back; each device sees the other as a real person", async () => {
    const e = await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 9000, homeMinor: 9000, shared: true, payer: 'self', splits: splitEqual(9000, ['self', U.B, 'n:하준'], 'seed') }) }, A.db)
    await sync2()
    await s.admin()
    const row = (await s.pg.query<{ money: Money; payer_id: string; created_by: string }>(`select money, payer_id, created_by from expenses where id = '${e.id}'`)).rows[0]
    expect(row.money.payer).toBe(U.A); expect(row.payer_id).toBe(U.A); expect(row.created_by).toBe(U.A)
    expect(row.money.splits.map((x) => x.k).sort()).toEqual([U.A, U.B, 'n:하준'].sort())      // 서버에는 'self' 가 없다
    const onB = (await B.db.expenses.get(e.id))!
    expect(onB.money.payer).toBe(U.A)                                                            // B에게 A는 UUID 사람
    expect(onB.money.splits.map((x) => x.k).sort()).toEqual(['self', U.A, 'n:하준'].sort())       // B 자신은 'self'
    expect((await A.db.expenses.get(e.id))!.money.payer).toBe('self')                            // A 화면에서는 그대로 'self'
  })

  it('both devices compute exactly the same settlement from the same shared expenses', async () => {
    await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 30001, homeMinor: 30001, shared: true, payer: 'self', splits: splitEqual(30001, ['self', U.B, 'n:하준'], 'e1') }) }, A.db)
    await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 12000, homeMinor: 12000, shared: true, payer: 'self', splits: [{ k: 'self', s: 2000 }, { k: U.A, s: 10000 }] }) }, B.db)   // B가 결제, A가 대부분 부담
    await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 5000, homeMinor: 5000, shared: true, payer: 'n:하준', splits: splitEqual(5000, ['self', 'n:하준'], 'e3') }) }, A.db)
    await sync2()
    const a = await settlement(A), b = await settlement(B)
    expect(a.length).toBeGreaterThan(0)
    expect(b).toEqual(a)
    const bal = balances((await listExpenses(tripId, A.db)).map((e) => ({ money: canon(A, e.money) })))
    expect(Object.values(bal).reduce((x, y) => x + y, 0)).toBe(0)
  })

  it('personal expenses stay private: the other companion never receives them, even on a full download', async () => {
    const mine = await addExpense(tripId, { categoryId: food, memo: 'A의 개인 지출', money: mk({ localMinor: 4000, homeMinor: 4000 }) }, A.db)
    const shared = await addExpense(tripId, { categoryId: food, money: mk({ shared: true, payer: 'self', splits: [{ k: 'self', s: 500 }, { k: U.B, s: 500 }] }) }, A.db)
    const theirs = await addExpense(tripId, { categoryId: food, memo: 'B의 개인 지출', money: mk({ localMinor: 7000, homeMinor: 7000 }) }, B.db)
    await sync2()
    expect((await B.db.expenses.toArray()).map((e) => e.id).sort()).toEqual([shared.id, theirs.id].sort())
    expect((await A.db.expenses.toArray()).map((e) => e.id).sort()).toEqual([mine.id, shared.id].sort())
    await downloadTrip(tripId, B.remote, B.db)                                                  // 처음부터 다시 받아도 같다
    expect((await B.db.expenses.toArray()).some((e) => e.id === mine.id)).toBe(false)
  })

  it('an expense created offline syncs once later, with no duplicate even when the first response is lost', async () => {
    B.state.down = true
    const e = await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 2500, homeMinor: 2500, shared: true, payer: 'self', splits: splitEqual(2500, ['self', U.A], 'off') }) }, B.db)
    expect((await syncTrip(tripId, B.remote, B.db)).error).toMatch(/네트워크/)
    B.state.down = false
    let first = true
    const lossy: RemoteAdapter = { ...B.remote, push: async (req) => { const r = await B.remote.push(req); if (first && req.table === 'expenses') { first = false; throw new SyncNetworkError() } return r } }
    await syncTrip(tripId, lossy, B.db)                                                          // 서버에는 반영, 응답 유실
    const r = await syncTrip(tripId, B.remote, B.db)                                             // 재시도
    expect(r.conflicts).toBe(0)
    await sync2()
    await s.admin(); expect((await s.pg.query(`select 1 from expenses where id = '${e.id}'`)).rows).toHaveLength(1)
    expect((await A.db.expenses.get(e.id))!.money.payer).toBe(U.B)
  })

  it('amount and split conflicts are one atomic conflict; resolving it leaves the server consistent either way', async () => {
    const e = await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 10000, homeMinor: 10000, shared: true, payer: 'self', splits: splitEqual(10000, ['self', U.B], 'c') }) }, A.db)
    await sync2()
    await updateExpense(e.id, { money: mk({ localMinor: 20000, homeMinor: 20000, shared: true, payer: 'self', splits: splitEqual(20000, ['self', U.B], 'c') }) }, A.db)             // A: 금액 변경
    await updateExpense(e.id, { money: mk({ localMinor: 10000, homeMinor: 10000, shared: true, payer: 'self', splits: [{ k: 'self', s: 7000 }, { k: U.A, s: 3000 }] }) }, B.db) // B: 분담 변경
    await syncTrip(tripId, A.remote, A.db)
    const r = await syncTrip(tripId, B.remote, B.db)
    expect(r.conflicts).toBe(1)
    const [c] = await B.db.conflicts.toArray()
    expect(c.field).toBe('money')
    await s.admin()
    const sv = (await s.pg.query<{ money: Money }>(`select money from expenses where id = '${e.id}'`)).rows[0].money
    expect(sv.homeMinor).toBe(20000); expect(sv.splits.reduce((x, y) => x + y.s, 0)).toBe(20000)   // 서버는 항상 합계가 맞는 상태
    await resolveConflict(c.id, 'mine', B.db)
    await sync2()
    await s.admin()
    const fin = (await s.pg.query<{ money: Money }>(`select money from expenses where id = '${e.id}'`)).rows[0].money
    expect(fin.homeMinor).toBe(10000); expect(fin.splits.reduce((x, y) => x + y.s, 0)).toBe(10000)
    for (const d of [A, B]) expect((await d.db.expenses.get(e.id))!.money.homeMinor).toBe(10000)
    expect(await A.db.conflicts.count()).toBe(0); expect(await B.db.conflicts.count()).toBe(0)
  })

  it('different fields still merge: one edits the memo while the other edits the amount', async () => {
    const e = await addExpense(tripId, { categoryId: food, memo: '', money: mk({ shared: true, payer: 'self', splits: [{ k: 'self', s: 600 }, { k: U.B, s: 400 }] }) }, A.db)
    await sync2()
    await updateExpense(e.id, { memo: 'A가 쓴 메모' }, A.db)
    await updateExpense(e.id, { money: mk({ localMinor: 2000, homeMinor: 2000, shared: true, payer: U.A, splits: [{ k: U.A, s: 1000 }, { k: 'self', s: 1000 }] }) }, B.db)
    await sync2()
    for (const d of [A, B]) { const x = (await d.db.expenses.get(e.id))!; expect([x.memo, x.money.homeMinor]).toEqual(['A가 쓴 메모', 2000]) }
  })

  it('deleting a shared expense removes it for everyone and the settlement updates', async () => {
    const e = await addExpense(tripId, { categoryId: food, money: mk({ localMinor: 8000, homeMinor: 8000, shared: true, payer: 'self', splits: splitEqual(8000, ['self', U.B], 'd') }) }, A.db)
    await sync2()
    expect((await settlement(B)).length).toBe(1)
    await deleteExpense(e.id, A.db); await sync2()
    expect(await listExpenses(tripId, B.db)).toHaveLength(0)
    expect(await settlement(B)).toEqual([])
  })

  it('links to itinerary items and shopping items survive syncing; the settlement of a removed member is preserved', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '점심' }, A.db)
    const sh = await addShopping(tripId, { name: '과자' }, A.db)
    const e = await addExpense(tripId, { categoryId: food, itineraryItemId: it.id, shoppingItemId: sh.id, money: mk({ shared: true, payer: 'self', splits: [{ k: 'self', s: 500 }, { k: U.B, s: 500 }] }) }, A.db)
    await sync2()
    const onB = (await B.db.expenses.get(e.id))!
    expect([onB.itineraryItemId, onB.shoppingItemId]).toEqual([it.id, sh.id])
    await A.api.removeMember(tripId, U.B)                                                       // B가 나가도 기존 지출과 정산 기록은 남는다
    await syncTrip(tripId, A.remote, A.db)
    expect((await settlement(A)).length).toBe(1)
    await updateExpense(e.id, { memo: '메모 추가' }, A.db)
    expect((await syncTrip(tripId, A.remote, A.db)).error).toBeNull()
    await s.admin(); expect((await s.pg.query<{ memo: string }>(`select memo from expenses where id = '${e.id}'`)).rows[0].memo).toBe('메모 추가')
  })
})
