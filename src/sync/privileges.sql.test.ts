// 비로그인(anon) 사용자와 권한이 없는 사용자가 아무것도 얻지 못하는지 확인한다. (실제 PostgreSQL 위에서)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, U, type TestServer } from './testServer'

let s: TestServer
const TRIP = '10000000-0000-0000-0000-0000000000a1'

beforeAll(async () => {
  s = await createTestServer()
  await s.as(U.A)
  await s.pg.query(`insert into trips (id, owner_id, name, start_date, end_date, time_zone) values ($1, $2, '비공개 여행', '2030-01-01', '2030-01-03', 'Asia/Tokyo')`, [TRIP, U.A])
  await s.admin()
  // anon 에게도 테이블 권한을 일부러 열어 둔 최악의 상황(Supabase 기본값)을 만든 뒤, 0009 가 막는지 본다
  await s.pg.exec('grant select, insert, update, delete on all tables in schema public to anon')
  // 이미 적용된 0009 를 다시 실행해도(멱등) 그 권한을 회수한다
  await s.pg.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '0009_harden_privileges.sql'), 'utf8'))
})

const denied = async (uid: string | null, sql: string) => {
  await s.as(uid)
  await expect(s.pg.query(sql)).rejects.toThrow()
  await s.admin()
}

describe('helper functions are not open to the public', () => {
  it('anonymous users cannot ask whether someone is a member of a trip', async () => {
    await denied(null, `select public.is_trip_member('${TRIP}')`)
    await denied(null, `select public.is_trip_admin('${TRIP}')`)
    await denied(null, `select public.trip_has_members('${TRIP}')`)
    await denied(null, `select public.exp_person_ok('${TRIP}', '${U.A}')`)
  })
  it('logged-in users still can (row security policies depend on it)', async () => {
    await s.as(U.A)
    const r = await s.pg.query<{ m: boolean }>(`select public.is_trip_member('${TRIP}') as m`)
    expect(r.rows[0].m).toBe(true)
  })
})

describe('anonymous users', () => {
  it('cannot read or write any table, even when the database default would allow it', async () => {
    for (const t of ['trips', 'trip_members', 'itinerary_items', 'places', 'checklist_items', 'shopping_items', 'expense_categories', 'expenses']) {
      await s.as(null)
      await expect(s.pg.query(`select * from ${t}`), `select ${t}`).rejects.toThrow()
      await s.admin()
    }
    await denied(null, `insert into trips (id, owner_id, name, start_date, end_date, time_zone) values (gen_random_uuid(), '${U.A}', 'x', '2030-01-01', '2030-01-02', 'UTC')`)
  })
  it('cannot call the sync function', async () => {
    await denied(null, `select public.sync_apply('places', gen_random_uuid(), 'upsert', 0, '{}'::jsonb, 'dev')`)
  })
})

describe('the sharing feature is gone from the server', () => {
  it('has no invite, join, member-management or profile functions', async () => {
    await s.admin()
    const fns = (await s.pg.query<{ proname: string }>(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).rows.map((r) => r.proname)
    for (const f of ['create_invite', 'join_trip', 'revoke_invite', 'list_members', 'set_member_role', 'remove_member', 'leave_trip', 'end_sharing', 'upsert_profile', 'hash_code', 'norm_code', 'require_auth']) {
      expect(fns, f).not.toContain(f)
    }
    for (const f of ['sync_apply', 'is_trip_member', 'exp_person_ok']) expect(fns, f).toContain(f)      // 남겨야 할 것은 그대로
  })
  it('has no invite or profile tables, and a signed-in user cannot add members to a trip, even their own', async () => {
    await s.admin()
    const tables = (await s.pg.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public'`)).rows.map((r) => r.tablename)
    for (const t of ['trip_invites', 'join_attempts', 'profiles']) expect(tables, t).not.toContain(t)
    await denied(U.A, `insert into trip_members (trip_id, user_id, role) values ('${TRIP}', '${U.C}', 'member')`)
    await denied(U.C, `insert into trip_members (trip_id, user_id, role) values ('${TRIP}', '${U.C}', 'admin')`)
  })
})

describe('users outside the trip', () => {
  it('see nothing and change nothing', async () => {
    await s.as(U.C)
    expect((await s.pg.query(`select * from trips`)).rows).toHaveLength(0)
    expect((await s.pg.query(`select * from trip_members`)).rows).toHaveLength(0)
    await s.pg.query(`update trips set name = '탈취' where id = '${TRIP}'`)   // 보이지 않는 행이라 0건 갱신
    await s.admin()
    const r = await s.pg.query<{ name: string }>(`select name from trips where id = '${TRIP}'`)
    expect(r.rows[0].name).toBe('비공개 여행')
    await s.as(U.C)
    // 다른 사람의 여행에는 동기화 함수로도 쓸 수 없다
    await expect(s.pg.query(`select public.sync_apply('places', gen_random_uuid(), 'upsert', 0, $1::jsonb, 'dev')`, [JSON.stringify({ trip_id: TRIP, name: 'x', lat: 1, lng: 1 })])).rejects.toThrow()
    await s.admin()
  })
})
