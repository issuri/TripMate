// 실제 PostgreSQL(PGlite)에서 마이그레이션을 순서대로 실행하고 RLS 권한을 검증한다.
// Supabase의 auth 스키마는 최소한으로 흉내 낸다(auth.users, auth.uid()).
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const DIR = join(process.cwd(), 'supabase', 'migrations')
const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const TRIP = '10000000-0000-0000-0000-000000000001'

let pg: PGlite
const as = async (uid: string | null) => {
  await pg.exec('reset role')
  await pg.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ''}', false)`)
  if (uid) await pg.exec('set role authenticated')
}

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role authenticated;
  `)
  for (const f of readdirSync(DIR).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(join(DIR, f), 'utf8'))
  await pg.exec(`grant usage on schema public, auth to authenticated; grant all on all tables in schema public to authenticated; grant execute on all functions in schema public, auth to authenticated; grant select on auth.users to authenticated;`)
  await pg.exec(`insert into auth.users values ('${A}'), ('${B}')`)
})

describe('SQL migrations', () => {
  it('all migrations run in order without errors', async () => {
    const r = await pg.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name='places' and column_name in ('external_id','google_place_id')`)
    expect(r.rows.map((x) => x.column_name)).toEqual(['external_id'])
    const s = await pg.query(`select 1 from information_schema.columns where table_name='shopping_items' and column_name='actual_price_minor'`)
    expect(s.rows).toHaveLength(1)
  })

  it('trip creator becomes admin automatically and can read the trip', async () => {
    await as(A)
    await pg.exec(`insert into trips (id, owner_id, name, start_date, end_date) values ('${TRIP}', '${A}', 'T', '2026-12-01', '2026-12-04')`)
    const trips = await pg.query(`select id from trips`)
    expect(trips.rows).toHaveLength(1)
    const m = await pg.query<{ role: string }>(`select role from trip_members where trip_id='${TRIP}' and user_id='${A}'`)
    expect(m.rows[0]?.role).toBe('admin')
  })

  it('non-members cannot read or write a trip and its data', async () => {
    await as(A)
    await pg.exec(`insert into itinerary_items (id, trip_id, day_number, title) values ('20000000-0000-0000-0000-000000000001', '${TRIP}', 1, '공항')`)
    await as(B)
    expect((await pg.query(`select id from trips`)).rows).toHaveLength(0)
    expect((await pg.query(`select id from itinerary_items`)).rows).toHaveLength(0)
    await expect(pg.exec(`insert into itinerary_items (id, trip_id, day_number, title) values ('20000000-0000-0000-0000-000000000002', '${TRIP}', 1, 'x')`)).rejects.toThrow()
    await expect(pg.exec(`insert into expenses (id, trip_id, category_id, amount_local_minor, local_currency, amount_home_minor) values (gen_random_uuid(), '${TRIP}', gen_random_uuid(), 1, 'KRW', 1)`)).rejects.toThrow()
    // 다른 사람 여행에 자기 자신을 멤버로 넣을 수도 없다
    await expect(pg.exec(`insert into trip_members (trip_id, user_id, role) values ('${TRIP}', '${B}', 'admin')`)).rejects.toThrow()
  })

  it('a user cannot create a trip owned by someone else', async () => {
    await as(B)
    await expect(pg.exec(`insert into trips (id, owner_id, name, start_date, end_date) values (gen_random_uuid(), '${A}', 'fake', '2026-12-01', '2026-12-02')`)).rejects.toThrow()
  })

  it('members can edit; only admins manage members; version increments on update', async () => {
    await as(A)
    await pg.exec(`insert into trip_members (trip_id, user_id, role) values ('${TRIP}', '${B}', 'member')`)
    await as(B)
    expect((await pg.query(`select id from trips`)).rows).toHaveLength(1)
    await pg.exec(`update itinerary_items set completed = true where trip_id='${TRIP}'`)
    const v = await pg.query<{ version: number; completed: boolean }>(`select version, completed from itinerary_items where trip_id='${TRIP}'`)
    expect(v.rows[0]).toMatchObject({ version: 2, completed: true })
    await pg.exec(`delete from trip_members where user_id='${A}' and trip_id='${TRIP}'`) // RLS가 0행으로 걸러냄
    await as(A)
    expect((await pg.query(`select 1 from trip_members where user_id='${A}'`)).rows).toHaveLength(1)
    await as(B)
    await expect(pg.exec(`update trips set name='hijack' where id='${TRIP}'`)).resolves.toBeDefined()
    await as(A)
    expect((await pg.query<{ name: string }>(`select name from trips`)).rows[0].name).toBe('T')
  })

  it('rejects invalid data: dates, negative money', async () => {
    await as(A)
    await expect(pg.exec(`insert into trips (id, owner_id, name, start_date, end_date) values (gen_random_uuid(), '${A}', 'bad', '2026-12-05', '2026-12-01')`)).rejects.toThrow()
    await expect(pg.exec(`insert into shopping_items (id, trip_id, name, actual_price_minor) values (gen_random_uuid(), '${TRIP}', 'x', -1)`)).rejects.toThrow()
  })
})
