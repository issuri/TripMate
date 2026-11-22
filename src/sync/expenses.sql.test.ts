// 지출 서버 검증(트리거)과 개인 경비 비공개(RLS)를 실제 PostgreSQL에서 확인한다.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestServer, U, type TestServer } from './testServer'

let s: TestServer
const TRIP = '10000000-0000-0000-0000-000000000001'
const CAT = '30000000-0000-0000-0000-000000000001'

const money = (o: Partial<{ local: number; home: number; cur: string; rate: number; shared: boolean; payer: string | null; splits: [string, number][]; raw: Record<string, unknown> }> = {}) =>
  JSON.stringify({
    localMinor: o.local ?? 1000, currency: o.cur ?? 'KRW', rateMicro: o.rate ?? 1_000_000, homeMinor: o.home ?? o.local ?? 1000,
    shared: o.shared ?? false, payer: o.payer === undefined ? null : o.payer, splits: (o.splits ?? []).map(([k, v]) => ({ k, s: v })), ...(o.raw ?? {}),
  })
const insert = async (uid: string, m: string, id = 'gen_random_uuid()') => {
  await s.as(uid)
  await s.pg.exec(`insert into expenses (id, trip_id, category_id, money) values (${id}, '${TRIP}', '${CAT}', '${m}'::jsonb)`)
}
const rows = async (uid: string) => { await s.as(uid); return (await s.pg.query<{ id: string }>(`select id from expenses`)).rows }
// 제품에는 멤버를 늘리는 기능이 없지만, 서버의 접근 규칙(RLS)은 여전히 멤버 단위라서 시험용으로 멤버를 직접 넣어 확인한다.
const invite = async (uid: string) => { await s.admin(); await s.pg.exec(`insert into trip_members (trip_id, user_id, role, status) values ('${TRIP}', '${uid}', 'member', 'active')`) }
const removeMember = async (uid: string) => { await s.admin(); await s.pg.exec(`update trip_members set status = 'removed' where trip_id = '${TRIP}' and user_id = '${uid}'`) }

beforeAll(async () => { s = await createTestServer() })
beforeEach(async () => {
  await s.admin(); await s.pg.exec('truncate trip_members, trips, expenses, expense_categories cascade')
  await s.as(U.A)
  await s.pg.exec(`insert into trips (id, owner_id, name, start_date, end_date) values ('${TRIP}', '${U.A}', '도쿄', '2030-05-10', '2030-05-12')`)
  await s.pg.exec(`insert into expense_categories (id, trip_id, name) values ('${CAT}', '${TRIP}', '식비')`)
  await invite(U.B)
})

describe('money validation trigger', () => {
  it('accepts valid personal and shared expenses and derives the legacy columns from money', async () => {
    await insert(U.A, money({ local: 1234, cur: 'USD', rate: 1_380_470_016, home: 17035, payer: U.A }), `'50000000-0000-0000-0000-000000000001'`)
    await insert(U.A, money({ local: 9000, shared: true, payer: U.A, splits: [[U.A, 3000], [U.B, 3000], ['n:하준', 3000]] }), `'50000000-0000-0000-0000-000000000002'`)
    await s.admin()
    const r = (await s.pg.query<Record<string, unknown>>(`select id, amount_local_minor::int a, local_currency c, fx_rate_micro::bigint r, amount_home_minor::int h, is_shared sh, payer_id from expenses order by id`)).rows
    expect(r[0]).toMatchObject({ a: 1234, c: 'USD', h: 17035, sh: false, payer_id: U.A })
    expect(Number(r[0].r)).toBe(1_380_470_016)
    expect(r[1]).toMatchObject({ a: 9000, sh: true })
  })

  it('rejects malformed money: missing, wrong types, bad numbers/currency/rate', async () => {
    const bad: [string, string][] = [
      ['null money', 'null'], ['array', '[]'], ['string', '"x"'],
      ['negative local', money({ local: -1 })], ['float local', money({ raw: { localMinor: 1.5 } })], ['string amount', money({ raw: { localMinor: 'abc' } })],
      ['huge amount', money({ raw: { homeMinor: 1e16 } })], ['bad currency', money({ cur: 'jpy' })], ['4 letters', money({ cur: 'JPYY' })],
      ['zero rate', money({ rate: 0 })], ['negative rate', money({ rate: -5 })], ['shared not boolean', money({ raw: { shared: 'yes' } })], ['splits not array', money({ raw: { splits: {} } })],
    ]
    for (const [label, m] of bad) await expect(insert(U.A, m), label).rejects.toThrow(/invalid_money|violates|invalid input/)
    expect(await rows(U.A)).toHaveLength(0)
  })

  it('shared expenses need a payer, participants, no duplicates and exact totals; personal expenses must not carry splits', async () => {
    await expect(insert(U.A, money({ shared: true, payer: null, splits: [[U.A, 1000]] }))).rejects.toThrow(/needs a payer/)
    await expect(insert(U.A, money({ shared: true, payer: U.A, splits: [] }))).rejects.toThrow(/needs participants/)
    await expect(insert(U.A, money({ shared: true, payer: U.A, splits: [[U.A, 500], [U.A, 500]] }))).rejects.toThrow(/duplicate/)
    await expect(insert(U.A, money({ shared: true, payer: U.A, splits: [[U.A, 500], [U.B, 499]] }))).rejects.toThrow(/do not add up/)
    await expect(insert(U.A, money({ shared: true, payer: U.A, splits: [[U.A, 600], [U.B, 600]] }))).rejects.toThrow(/do not add up/)
    await expect(insert(U.A, money({ shared: true, payer: U.A, splits: [[U.A, -1], [U.B, 1001]] }))).rejects.toThrow(/bad split/)
    await expect(insert(U.A, money({ shared: false, payer: U.A, splits: [[U.A, 1000]] }))).rejects.toThrow(/must not have splits/)
    expect(await rows(U.A)).toHaveLength(0)
  })

  it('person keys: only real active members (UUID) or "n:name"; device-internal "self" and arbitrary text never reach the server', async () => {
    await expect(insert(U.A, money({ payer: 'self' }))).rejects.toThrow(/payer is not a member/)
    await expect(insert(U.A, money({ payer: 'someone' }))).rejects.toThrow(/payer/)
    await expect(insert(U.A, money({ payer: U.C }))).rejects.toThrow(/payer/)                       // 계정은 있지만 이 여행 멤버가 아님
    await expect(insert(U.A, money({ shared: true, payer: U.A, splits: [[U.A, 500], [U.C, 500]] }))).rejects.toThrow(/participant/)
    await expect(insert(U.A, money({ shared: true, payer: U.A, splits: [[U.A, 500], ['n:' + 'x'.repeat(61), 500]] }))).rejects.toThrow(/participant/)
    await expect(insert(U.A, money({ shared: true, payer: U.A, splits: [[U.A, 500], ['n:', 500]] }))).rejects.toThrow(/participant/)
    await insert(U.A, money({ shared: true, payer: 'n:민수', splits: [['n:민수', 500], [U.B, 500]] }))      // 이름만 있는 동행자는 허용
    expect(await rows(U.A)).toHaveLength(1)
  })

  it('clients cannot desynchronise the legacy columns: they are recomputed from money on every write', async () => {
    const id = '50000000-0000-0000-0000-000000000009'
    await insert(U.A, money({ local: 1000, payer: U.A }), `'${id}'`)
    await s.as(U.A)
    await s.pg.exec(`update expenses set amount_home_minor = 1, amount_local_minor = 1, is_shared = true, payer_id = null where id = '${id}'`)
    await s.admin()
    expect((await s.pg.query<{ h: number; l: number; sh: boolean; p: string }>(`select amount_home_minor::int h, amount_local_minor::int l, is_shared sh, payer_id p from expenses where id='${id}'`)).rows[0]).toEqual({ h: 1000, l: 1000, sh: false, p: U.A })
  })

  it('a removed member stays valid in expenses they were already part of, but cannot be added to new ones', async () => {
    const id = '50000000-0000-0000-0000-00000000000a'
    await insert(U.A, money({ shared: true, payer: U.B, splits: [[U.A, 500], [U.B, 500]] }), `'${id}'`)
    await removeMember(U.B)
    await s.as(U.A)
    await s.pg.exec(`update expenses set memo = '메모만 수정' where id = '${id}'`)                                   // 과거 기록의 다른 필드 수정
    await s.pg.exec(`update expenses set money = '${money({ shared: true, payer: U.B, local: 2000, splits: [[U.A, 1000], [U.B, 1000]] })}'::jsonb where id = '${id}'`) // 금액을 고쳐도 기존 참여자는 유지
    await expect(insert(U.A, money({ shared: true, payer: U.A, splits: [[U.A, 500], [U.B, 500]] }))).rejects.toThrow(/participant/)   // 새 지출에는 불가
    await expect(insert(U.A, money({ payer: U.B }))).rejects.toThrow(/payer/)
    await s.admin()
    expect((await s.pg.query<{ h: number }>(`select amount_home_minor::int h from expenses where id='${id}'`)).rows[0].h).toBe(2000)
  })
})

describe('personal expenses are private to their author', () => {
  it('a member never sees, edits or deletes another member personal expense, but shared ones are open to all members', async () => {
    const mine = '50000000-0000-0000-0000-00000000000b', shared = '50000000-0000-0000-0000-00000000000c'
    await insert(U.A, money({ payer: U.A }), `'${mine}'`)
    await insert(U.A, money({ shared: true, payer: U.A, splits: [[U.A, 500], [U.B, 500]] }), `'${shared}'`)
    expect((await rows(U.A)).length).toBe(2)
    expect((await rows(U.B)).map((r) => r.id)).toEqual([shared])                         // 개인 경비는 보이지 않는다
    await s.as(U.B)
    await s.pg.exec(`update expenses set memo = '남의 개인 경비 수정' where id = '${mine}'`)
    await s.pg.exec(`delete from expenses where id = '${mine}'`)
    await s.pg.exec(`update expenses set memo = 'B가 공동 경비 수정' where id = '${shared}'`)
    await s.admin()
    const r = (await s.pg.query<{ id: string; memo: string }>(`select id, memo from expenses order by id`)).rows
    expect(r).toEqual([{ id: mine, memo: '' }, { id: shared, memo: 'B가 공동 경비 수정' }])  // 개인 경비는 그대로, 공동 경비는 B가 고침
  })
  it('a shared expense can never be turned into a personal one (nobody — not even the author — can make it vanish for others); personal can become shared', async () => {
    const shared = '50000000-0000-0000-0000-00000000000d', personal = '50000000-0000-0000-0000-0000000000f1'
    await insert(U.A, money({ shared: true, payer: U.A, splits: [[U.A, 1000]] }), `'${shared}'`)
    await s.as(U.B)
    await expect(s.pg.exec(`update expenses set money = '${money({ payer: U.B })}'::jsonb where id = '${shared}'`)).rejects.toThrow(/cannot become personal/)
    await s.as(U.A)
    await expect(s.pg.exec(`update expenses set money = '${money({ payer: U.A })}'::jsonb where id = '${shared}'`)).rejects.toThrow(/cannot become personal/)
    expect((await rows(U.B))).toHaveLength(1)                                                                    // B에게 계속 보인다
    await insert(U.A, money({ payer: U.A }), `'${personal}'`)
    expect((await rows(U.B))).toHaveLength(1)                                                                    // 개인 경비는 B에게 안 보임
    await s.as(U.A)
    await s.pg.exec(`update expenses set money = '${money({ shared: true, payer: U.A, splits: [[U.A, 500], [U.B, 500]] })}'::jsonb where id = '${personal}'`)
    expect((await rows(U.B))).toHaveLength(2)                                                                    // 공유하면 B에게 나타난다
  })
  it('the author is set by the server and cannot be forged or changed', async () => {
    const id = '50000000-0000-0000-0000-00000000000e'
    await s.as(U.B)
    await s.pg.exec(`insert into expenses (id, trip_id, category_id, money, created_by) values ('${id}', '${TRIP}', '${CAT}', '${money({ payer: U.B })}'::jsonb, '${U.A}')`)
    await s.admin()
    expect((await s.pg.query<{ c: string }>(`select created_by c from expenses where id='${id}'`)).rows[0].c).toBe(U.B)     // 위조해도 B
    await s.as(U.B)
    await s.pg.exec(`update expenses set created_by = '${U.A}' where id = '${id}'`)
    await s.admin()
    expect((await s.pg.query<{ c: string }>(`select created_by c from expenses where id='${id}'`)).rows[0].c).toBe(U.B)
    expect((await rows(U.A)).length).toBe(0)                                                  // A는 B의 개인 경비를 못 본다(같은 여행 관리자라도)
  })
  it('non-members and removed members see no expenses at all', async () => {
    await insert(U.A, money({ shared: true, payer: U.A, splits: [[U.A, 1000]] }))
    expect(await rows(U.C)).toHaveLength(0)
    await expect(insert(U.C, money({ payer: null }))).rejects.toThrow(/row-level security/)
    await removeMember(U.B)
    expect(await rows(U.B)).toHaveLength(0)
  })
})
