// 공유(초대·참여·권한) 서버 로직을 실제 PostgreSQL에서 검증한다: 권한 행렬, 만료/취소/소진, 무차별 대입, 직접 쓰기 차단.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestServer, U, type TestServer } from './testServer'

let s: TestServer
const TRIP = '10000000-0000-0000-0000-000000000001'
type Join = { status: 'ok' | 'error'; trip_id?: string; code?: string; already?: boolean }

beforeAll(async () => { s = await createTestServer() })
beforeEach(async () => {
  await s.admin()
  await s.pg.exec(`truncate trip_members, trip_invites, join_attempts, trips, profiles cascade`)
  await s.as(U.A)
  await s.pg.exec(`insert into trips (id, owner_id, name, start_date, end_date) values ('${TRIP}', '${U.A}', '도쿄', '2030-05-10', '2030-05-12')`)
})

const invite = (uid = U.A, hours = 168, uses = 5) => s.rpc<string>(uid, 'create_invite', [TRIP, hours, uses])
const join = (uid: string, code: string) => s.rpc<Join>(uid, 'join_trip', [code])
const members = async (uid: string) => { await s.as(uid); return (await s.pg.query<{ user_id: string; role: string; status: string; display_name: string }>('select * from public.list_members($1)', [TRIP])).rows }
const role = async (uid: string) => { await s.admin(); return (await s.pg.query<{ role: string; status: string }>(`select role, status from trip_members where trip_id='${TRIP}' and user_id='${uid}'`)).rows[0] }
const canRead = async (uid: string) => { await s.as(uid); return (await s.pg.query(`select id from trips where id='${TRIP}'`)).rows.length === 1 }
async function addItem(uid: string) { await s.as(uid); await s.pg.exec(`insert into itinerary_items (id, trip_id, day_number, title) values (gen_random_uuid(), '${TRIP}', 1, 'x')`) }

describe('invite codes', () => {
  it('creator is admin; code has the documented format; only a hash is stored', async () => {
    expect(await role(U.A)).toEqual({ role: 'admin', status: 'active' })
    const code = await invite()
    expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
    await s.admin()
    const rows = (await s.pg.query<{ code_hash: string }>(`select code_hash from trip_invites`)).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(rows)).not.toContain(code.replace(/-/g, ''))
  })
  it('codes are unique and unguessable-looking across many invites', async () => {
    const codes = new Set<string>()
    for (let i = 0; i < 20; i++) codes.add(await invite(U.A, 24, 1))
    expect(codes.size).toBe(20)
    await expect(invite()).rejects.toThrow(/too_many_invites/)               // 활성 초대는 20개까지
  })
  it('only admins can create invites; members and strangers cannot; bad arguments are rejected', async () => {
    const code = await invite()
    await join(U.B, code)
    await expect(invite(U.B)).rejects.toThrow(/forbidden/)
    await expect(invite(U.C)).rejects.toThrow(/forbidden/)
    await expect(s.rpc(U.A, 'create_invite', [TRIP, 0, 5])).rejects.toThrow(/invalid_argument/)
    await expect(s.rpc(U.A, 'create_invite', [TRIP, 1000, 5])).rejects.toThrow(/invalid_argument/)
    await expect(s.rpc(U.A, 'create_invite', [TRIP, 24, 0])).rejects.toThrow(/invalid_argument/)
    await expect(s.rpc(U.A, 'create_invite', [TRIP, 24, 51])).rejects.toThrow(/invalid_argument/)
  })
  it('every RPC rejects anonymous callers', async () => {
    const code = await invite()
    for (const [fn, args] of [['create_invite', [TRIP, 24, 1]], ['join_trip', [code]], ['list_members', [TRIP]], ['end_sharing', [TRIP]], ['leave_trip', [TRIP]], ['upsert_profile', ['x']],
      ['set_member_role', [TRIP, U.B, 'admin']], ['remove_member', [TRIP, U.B]], ['revoke_invite', ['00000000-0000-0000-0000-000000000000']]] as const) {
      await expect(s.rpc(null, fn, [...args]), fn).rejects.toThrow()
    }
  })
})

describe('joining', () => {
  it('joining with a valid code makes the user an active member who can read and edit, with a role of member', async () => {
    expect(await canRead(U.B)).toBe(false)
    const r = await join(U.B, await invite())
    expect(r).toMatchObject({ status: 'ok', trip_id: TRIP })
    expect(await role(U.B)).toEqual({ role: 'member', status: 'active' })
    expect(await canRead(U.B)).toBe(true)
    await addItem(U.B)                                                       // 동행자는 일정 공동 수정 가능
    await s.as(U.B)
    await expect(s.pg.exec(`update trips set name = 'x' where id='${TRIP}'`)).resolves.toBeDefined()
    await s.admin(); expect((await s.pg.query<{ name: string }>(`select name from trips`)).rows[0].name).toBe('도쿄') // 여행 정보는 관리자만
  })
  it('accepts lowercase / no dashes / spaces', async () => {
    const code = await invite()
    expect((await join(U.B, code.toLowerCase().replace(/-/g, ' '))).status).toBe('ok')
  })
  it('respects max uses and does not consume a use when an active member re-joins', async () => {
    const code = await invite(U.A, 24, 2)
    expect((await join(U.B, code)).status).toBe('ok')
    expect((await join(U.B, code)).already).toBe(true)                      // 이미 참여 중: 소모하지 않음
    expect((await join(U.C, code)).status).toBe('ok')                      // 2번째 사용
    expect(await join(U.D, code)).toMatchObject({ status: 'error', code: 'invalid_invite' }) // 소진
    await s.admin(); expect((await s.pg.query<{ used_count: number }>(`select used_count from trip_invites`)).rows[0].used_count).toBe(2)
  })
  it('expired, revoked, unknown and deleted-trip codes all fail with the same generic error', async () => {
    const expired = await invite(); await s.admin(); await s.pg.exec(`update trip_invites set expires_at = now() - interval '1 minute'`)
    const revoked = await invite()
    await s.as(U.A); const id = (await s.pg.query<{ id: string }>(`select id from trip_invites where not revoked and expires_at > now()`)).rows[0].id
    await s.rpc(U.A, 'revoke_invite', [id])
    const results = [await join(U.B, expired), await join(U.B, revoked), await join(U.B, 'AAAA-BBBB-CCCC')]
    for (const r of results) expect(r).toEqual({ status: 'error', code: 'invalid_invite' })   // 이유를 구분해 알려주지 않음
    const live = await invite(); await s.admin(); await s.pg.exec(`update trips set deleted_at = now()`)
    expect(await join(U.C, live)).toEqual({ status: 'error', code: 'invalid_invite' })
  })
  it('locks out brute force: failed attempts are recorded (not rolled back) and block further tries for that user only', async () => {
    const code = await invite(U.A, 24, 10)
    for (let i = 0; i < 8; i++) expect((await join(U.B, `BAD${i}-0000-0000`)).code).toBe('invalid_invite')
    expect(await join(U.B, code)).toEqual({ status: 'error', code: 'too_many_attempts' })   // 올바른 코드도 잠시 막힌다
    expect(await canRead(U.B)).toBe(false)
    expect((await join(U.C, code)).status).toBe('ok')                                         // 다른 사용자는 영향 없음
    await s.admin()
    expect((await s.pg.query<{ n: number }>(`select count(*)::int as n from join_attempts where user_id='${U.B}'`)).rows[0].n).toBe(8)   // 실패 8건 기록(롤백되지 않음). 잠금 중 시도는 기록하지 않아 잠금이 무한히 늘어나지 않는다
    await s.pg.exec(`update join_attempts set at = now() - interval '11 minutes'`)         // 10분이 지나면 풀린다
    expect((await join(U.B, code)).status).toBe('ok')
  })
})

describe('roles and membership management', () => {
  beforeEach(async () => { await join(U.B, await invite()); await join(U.C, await invite()) })

  it('admin can promote/demote; members cannot; the last admin can never be demoted or leave', async () => {
    await expect(s.rpc(U.B, 'set_member_role', [TRIP, U.C, 'admin'])).rejects.toThrow(/forbidden/)
    await s.rpc(U.A, 'set_member_role', [TRIP, U.B, 'admin'])
    expect((await role(U.B)).role).toBe('admin')
    await s.rpc(U.B, 'set_member_role', [TRIP, U.A, 'member'])               // 이제 B도 관리자라서 가능
    await expect(s.rpc(U.B, 'set_member_role', [TRIP, U.B, 'member'])).rejects.toThrow(/last_admin/)
    await expect(s.rpc(U.B, 'leave_trip', [TRIP])).rejects.toThrow(/last_admin/)
    await expect(s.rpc(U.B, 'set_member_role', [TRIP, U.B, 'owner'])).rejects.toThrow(/invalid_argument/)
    await expect(s.rpc(U.B, 'set_member_role', [TRIP, U.D, 'member'])).rejects.toThrow(/not_found/)
  })
  it('removing a member cuts off all access immediately and keeps their history', async () => {
    await s.as(U.B)
    const cat = '30000000-0000-0000-0000-000000000001'
    await s.pg.exec(`insert into expense_categories (id, trip_id, name) values ('${cat}', '${TRIP}', '식비')`)
    await s.pg.exec(`insert into expenses (id, trip_id, category_id, amount_local_minor, local_currency, amount_home_minor, payer_id) values (gen_random_uuid(), '${TRIP}', '${cat}', 100, 'KRW', 100, '${U.B}')`)
    await expect(s.rpc(U.B, 'remove_member', [TRIP, U.C])).rejects.toThrow(/forbidden/)  // 멤버는 내보낼 수 없다
    await expect(s.rpc(U.A, 'remove_member', [TRIP, U.A])).rejects.toThrow(/use_leave/)
    await s.rpc(U.A, 'remove_member', [TRIP, U.B])                                     // B가 결제자인 지출이 있어도 가능(삭제가 아님)
    expect(await role(U.B)).toMatchObject({ status: 'removed' })
    expect(await canRead(U.B)).toBe(false)
    await expect(addItem(U.B)).rejects.toThrow()
    await s.as(U.B); expect((await s.pg.query(`select 1 from expenses`)).rows).toHaveLength(0)
    await s.admin(); expect((await s.pg.query(`select 1 from expenses where payer_id='${U.B}'`)).rows).toHaveLength(1) // 과거 정산 기록은 보존
    await expect(s.rpc(U.A, 'remove_member', [TRIP, U.B])).rejects.toThrow(/not_found/) // 이미 내보냄
  })
  it('removed and left members disappear from the list for members but admins still see them', async () => {
    await s.rpc(U.A, 'remove_member', [TRIP, U.B]); await s.rpc(U.C, 'leave_trip', [TRIP])
    expect((await members(U.A)).map((m) => `${m.user_id.slice(-1)}:${m.status}`).sort()).toEqual(['a:active', 'b:removed', 'c:left'])
    await s.rpc(U.A, 'set_member_role', [TRIP, U.A, 'admin'])
    await expect(members(U.B)).rejects.toThrow(/forbidden/)                    // 내보내진 사람은 목록도 못 본다
  })
  it('a member can leave; afterwards they have no access; they can rejoin only with a new invite as a plain member', async () => {
    await s.rpc(U.C, 'leave_trip', [TRIP])
    expect(await canRead(U.C)).toBe(false)
    await s.rpc(U.A, 'set_member_role', [TRIP, U.B, 'admin'])
    await expect(s.rpc(U.C, 'leave_trip', [TRIP])).rejects.toThrow(/forbidden/)  // 이미 나감
    expect((await join(U.C, await invite())).status).toBe('ok')
    expect(await role(U.C)).toEqual({ role: 'member', status: 'active' })
  })
  it('end_sharing removes everyone else, revokes all invites and leaves the trip private to the admin', async () => {
    const pending = await invite()
    await expect(s.rpc(U.B, 'end_sharing', [TRIP])).rejects.toThrow(/forbidden/)
    expect(await s.rpc(U.A, 'end_sharing', [TRIP])).toBe(2)
    expect(await canRead(U.B)).toBe(false); expect(await canRead(U.C)).toBe(false); expect(await canRead(U.A)).toBe(true)
    expect(await join(U.D, pending)).toEqual({ status: 'error', code: 'invalid_invite' })
    await s.admin(); expect((await s.pg.query(`select 1 from trip_invites where not revoked`)).rows).toHaveLength(0)
  })
  it('even the original owner loses access completely once another admin removes them', async () => {
    await join(U.B, await invite())
    await s.rpc(U.A, 'set_member_role', [TRIP, U.B, 'admin'])
    await s.rpc(U.B, 'remove_member', [TRIP, U.A])                 // 소유자 A가 B(관리자)에게 내보내짐
    expect(await canRead(U.A)).toBe(false)                         // 여행 행도 더 이상 보이지 않는다
    await expect(addItem(U.A)).rejects.toThrow()
    await expect(s.rpc(U.A, 'create_invite', [TRIP, 24, 1])).rejects.toThrow(/forbidden/)
    expect(await canRead(U.B)).toBe(true)
  })
  it('a freshly created trip is readable by its creator right away (before/without extra membership rows)', async () => {
    const T3 = '10000000-0000-0000-0000-000000000003'
    await s.as(U.D)
    const r = await s.pg.query(`insert into trips (id, owner_id, name, start_date, end_date) values ('${T3}', '${U.D}', '새 여행', '2030-01-01', '2030-01-02') returning id`)
    expect(r.rows).toHaveLength(1)
  })
  it('a member of one trip cannot touch another trip they are not in', async () => {
    const T2 = '10000000-0000-0000-0000-000000000002'
    await s.as(U.D); await s.pg.exec(`insert into trips (id, owner_id, name, start_date, end_date) values ('${T2}', '${U.D}', '다른 여행', '2030-01-01', '2030-01-02')`)
    await expect(s.rpc(U.B, 'list_members', [T2])).rejects.toThrow(/forbidden/)
    await expect(s.rpc(U.B, 'create_invite', [T2, 24, 1])).rejects.toThrow(/forbidden/)
    await expect(s.rpc(U.B, 'remove_member', [T2, U.D])).rejects.toThrow(/forbidden/)
    await expect(s.rpc(U.B, 'end_sharing', [T2])).rejects.toThrow(/forbidden/)
    await s.as(U.B); expect((await s.pg.query(`select id from trips where id='${T2}'`)).rows).toHaveLength(0)
  })
})

describe('direct table writes are blocked (RPC only)', () => {
  it('nobody can insert/update/delete members or invites directly, not even admins', async () => {
    const code = await invite(); await join(U.B, code)
    await s.as(U.A)
    await expect(s.pg.exec(`insert into trip_members (trip_id, user_id, role) values ('${TRIP}', '${U.D}', 'admin')`)).rejects.toThrow()
    await expect(s.pg.exec(`insert into trip_invites (trip_id, code_hash, created_by, expires_at) values ('${TRIP}', 'weak', '${U.A}', now() + interval '1 day')`)).rejects.toThrow()
    await s.pg.exec(`update trip_members set role = 'admin' where user_id = '${U.B}'`)            // RLS가 0행으로 걸러냄
    await s.pg.exec(`delete from trip_members where user_id = '${U.B}'`)
    await s.pg.exec(`update trip_invites set max_uses = 9999, revoked = false`)
    await s.admin()
    expect((await role(U.B)).role).toBe('member')
    expect((await s.pg.query<{ max_uses: number }>(`select max_uses from trip_invites`)).rows[0].max_uses).toBe(5)
    await s.as(U.B)
    await expect(s.pg.exec(`insert into trip_members (trip_id, user_id, role) values ('${TRIP}', '${U.B}', 'admin')`)).rejects.toThrow()   // 자기 자신을 관리자로
    await s.pg.exec(`update trip_members set role = 'admin' where user_id = '${U.B}'`)
    expect((await role(U.B)).role).toBe('member')
    await s.as(U.B); expect((await s.pg.query(`select 1 from join_attempts`)).rows).toHaveLength(0)  // 시도 기록 테이블도 직접 못 본다
    await expect(s.pg.exec(`insert into join_attempts (user_id) values ('${U.B}')`)).rejects.toThrow()
  })
  it('members can read the invite list only if they are admins; nobody sees plaintext codes', async () => {
    await invite(); await join(U.B, await invite())
    await s.as(U.B); expect((await s.pg.query(`select 1 from trip_invites`)).rows).toHaveLength(0)
    await s.as(U.A); expect((await s.pg.query(`select 1 from trip_invites`)).rows).toHaveLength(2)
  })
})

describe('profiles', () => {
  it('co-members see each other names; strangers do not; nobody edits someone else', async () => {
    await s.rpc(U.A, 'upsert_profile', ['지은']); await s.rpc(U.B, 'upsert_profile', ['민수']); await s.rpc(U.D, 'upsert_profile', ['낯선 사람'])
    await join(U.B, await invite())
    expect((await members(U.A)).map((m) => m.display_name).sort()).toEqual(['민수', '지은'])
    await s.as(U.B)
    expect((await s.pg.query<{ display_name: string }>(`select display_name from profiles order by 1`)).rows.map((r) => r.display_name)).toEqual(['민수', '지은'])  // 낯선 사람은 안 보임
    await s.pg.exec(`update profiles set display_name = '해킹' where id = '${U.A}'`)
    await s.admin(); expect((await s.pg.query<{ display_name: string }>(`select display_name from profiles where id='${U.A}'`)).rows[0].display_name).toBe('지은')
    await expect(s.rpc(U.B, 'upsert_profile', ['x'.repeat(51)])).rejects.toThrow(/invalid_argument/)
    await s.rpc(U.B, 'upsert_profile', ['  민수2  ']); await s.admin()
    expect((await s.pg.query<{ display_name: string }>(`select display_name from profiles where id='${U.B}'`)).rows[0].display_name).toBe('민수2')
  })
  it('after being removed, the former member can no longer read the others profiles', async () => {
    await s.rpc(U.A, 'upsert_profile', ['지은']); await join(U.B, await invite())
    await s.rpc(U.A, 'remove_member', [TRIP, U.B])
    await s.as(U.B); expect((await s.pg.query(`select 1 from profiles where id = '${U.A}'`)).rows).toHaveLength(0)
  })
})
