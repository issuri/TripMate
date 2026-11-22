// 테스트용 "기기": 각자 로컬 DB(IndexedDB)와 서버(PGlite) 연결을 가진 기기. 서버는 testServer.ts.
// 같은 사용자(uid)로 기기를 두 대 만들면 "내 폰과 내 태블릿"이 된다.
import { TripMateDB } from '../db/local'
import { SyncNetworkError, type PushRequest, type PushResult, type RemoteAdapter } from './engine'
import type { TestServer } from './testServer'

export interface Device { uid: string; db: TripMateDB; remote: RemoteAdapter; state: { down: boolean } }

export async function makeDevice(s: TestServer, uid: string, name: string): Promise<Device> {
  const db = new TripMateDB('f-' + Math.random()); await db.open()
  const state = { down: false }
  const guard = () => { if (state.down) throw new SyncNetworkError() }
  const remote: RemoteAdapter = {
    userId: () => uid, clientId: () => 'dev-' + name,
    async push(req: PushRequest) { guard(); await s.as(uid); try { return (await s.pg.query<{ r: PushResult }>('select public.sync_apply($1, $2::uuid, $3, $4, $5::jsonb, $6) as r', [req.table, req.id, req.op, req.baseVersion, JSON.stringify(req.fields), req.clientId])).rows[0].r } catch (e) { throw new Error((e as Error).message) } },
    async pull(table, tripId, since) { guard(); await s.as(uid); return (await s.pg.query<{ j: Record<string, unknown> }>(`select to_jsonb(t) as j from public.${table} t where ${table === 'trips' ? 'id' : 'trip_id'} = $1::uuid and updated_at > to_timestamp($2 / 1000.0) order by updated_at, id`, [tripId, since])).rows.map((x) => x.j) },
    async listTrips() { guard(); await s.as(uid); return (await s.pg.query<{ id: string }>(`select id from public.trips where deleted_at is null`)).rows.map((r) => r.id) },
    async access(tripId) { guard(); await s.as(uid); return (await s.pg.query(`select id from public.trips where id = $1::uuid`, [tripId])).rows.length ? 'ok' : 'denied' },
  }
  return { uid, db, remote, state }
}
