// 테스트용 "기기": 각자 로컬 DB(IndexedDB)와 서버(PGlite) 연결을 가진 사용자. 서버는 testServer.ts.
import { TripMateDB } from '../db/local'
import { SyncNetworkError, type PushRequest, type PushResult, type RemoteAdapter } from './engine'
import { createSharingApi, RPC_PARAMS, type SharingApi } from './sharing'
import type { TestServer } from './testServer'

export interface Device { uid: string; db: TripMateDB; remote: RemoteAdapter; api: SharingApi; state: { down: boolean } }

export async function makeDevice(s: TestServer, uid: string, name: string): Promise<Device> {
  const db = new TripMateDB('f-' + Math.random()); await db.open()
  const state = { down: false }
  const guard = () => { if (state.down) throw new SyncNetworkError() }
  const fetchGuard = () => { if (state.down) throw new TypeError('Failed to fetch') }   // 실제 fetch 실패와 같은 오류
  const remote: RemoteAdapter = {
    userId: () => uid, clientId: () => 'dev-' + name,
    async push(req: PushRequest) { guard(); await s.as(uid); try { return (await s.pg.query<{ r: PushResult }>('select public.sync_apply($1, $2::uuid, $3, $4, $5::jsonb, $6) as r', [req.table, req.id, req.op, req.baseVersion, JSON.stringify(req.fields), req.clientId])).rows[0].r } catch (e) { throw new Error((e as Error).message) } },
    async pull(table, tripId, since) { guard(); await s.as(uid); return (await s.pg.query<{ j: Record<string, unknown> }>(`select to_jsonb(t) as j from public.${table} t where ${table === 'trips' ? 'id' : 'trip_id'} = $1::uuid and updated_at > to_timestamp($2 / 1000.0) order by updated_at, id`, [tripId, since])).rows.map((x) => x.j) },
    async listTrips() { guard(); await s.as(uid); return (await s.pg.query<{ id: string }>(`select id from public.trips where deleted_at is null`)).rows.map((r) => r.id) },
    async access(tripId) { guard(); await s.as(uid); return (await s.pg.query(`select id from public.trips where id = $1::uuid`, [tripId])).rows.length ? 'ok' : 'denied' },
  }
  const rpc = async (fn: keyof typeof RPC_PARAMS, args: Record<string, unknown>) => {
    fetchGuard(); await s.as(uid)
    const names = RPC_PARAMS[fn]; const vals = names.map((n) => args[n]); const ph = vals.map((_, i) => `$${i + 1}`).join(', ')
    // 집합을 돌려주는 함수는 PostgREST처럼 행 배열로 돌려준다
    if (fn === 'list_members') return (await s.pg.query(`select * from public.${fn}(${ph})`, vals as never)).rows
    const r = await s.pg.query<{ r: unknown }>(`select public.${fn}(${ph}) as r`, vals as never)
    return r.rows[0].r
  }
  const list = async (tripId: string) => { fetchGuard(); await s.as(uid); return (await s.pg.query<Record<string, unknown>>(`select * from public.trip_invites where trip_id = $1 order by created_at desc`, [tripId])).rows }
  return { uid, db, remote, api: createSharingApi(rpc, list), state }
}
