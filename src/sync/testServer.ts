// 테스트용 서버: 실제 PostgreSQL(PGlite)에 supabase/migrations 를 순서대로 적용하고, Supabase의 auth 스키마를 최소한으로 흉내 낸다.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const U = {
  A: '00000000-0000-0000-0000-00000000000a', B: '00000000-0000-0000-0000-00000000000b',
  C: '00000000-0000-0000-0000-00000000000c', D: '00000000-0000-0000-0000-00000000000d',
}

export interface TestServer {
  pg: PGlite
  /** uid 로 인증된 authenticated 역할로 전환(null 이면 익명) */
  as(uid: string | null): Promise<void>
  /** 슈퍼유저(RLS 우회)로 전환 */
  admin(): Promise<void>
  rpc<T = unknown>(uid: string | null, fn: string, args?: unknown[]): Promise<T>
}

export async function createTestServer(): Promise<TestServer> {
  const pg = new PGlite()
  await pg.exec(`
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role authenticated; create role anon;`)
  const dir = join(process.cwd(), 'supabase', 'migrations')
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(join(dir, f), 'utf8'))
  await pg.exec(`grant usage on schema public, auth to authenticated, anon;
    grant all on all tables in schema public to authenticated; grant all on all sequences in schema public to authenticated;
    grant execute on all functions in schema auth to authenticated, anon;`)
  await pg.exec(`insert into auth.users values ${Object.values(U).map((u) => `('${u}')`).join(',')}`)
  const server: TestServer = {
    pg,
    async as(uid) {
      await pg.exec('reset role')
      await pg.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ''}', false)`)
      await pg.exec(uid ? 'set role authenticated' : 'set role anon')
    },
    async admin() { await pg.exec('reset role') },
    async rpc<T>(uid: string | null, fn: string, args: unknown[] = []) {
      await server.as(uid)
      const ph = args.map((_, i) => `$${i + 1}`).join(', ')
      const r = await pg.query<{ r: T }>(`select public.${fn}(${ph}) as r`, args)
      return r.rows[0].r
    },
  }
  return server
}
