import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SyncNetworkError, SyncRejected, type PushRequest, type PushResult, type RemoteAdapter } from './engine'
import type { RemoteRow } from './schema'

/** 환경변수가 없으면 null → 앱은 "서버 미설정" 상태(로컬 전용)로 동작한다. 키는 코드에 넣지 않는다. */
export function createSupabase(): SupabaseClient | null {
  const url = import.meta.env.VITE_SUPABASE_URL, key = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } })
}

const isNetwork = (msg: string) => (typeof navigator !== 'undefined' && navigator.onLine === false) || /failed to fetch|network|load failed|timeout/i.test(msg)
const PAGE = 500

const WATCHED = ['trips', 'places', 'itinerary_items', 'checklist_items', 'shopping_items', 'expense_categories', 'expenses'] as const

/**
 * 다른 사람이 여행을 바꾸면 알림을 받는다(Supabase Realtime). RLS가 적용되어 참여 중인 멤버의 변경만 온다.
 * 알림은 "다시 동기화하라"는 신호로만 쓰고 데이터는 동기화 엔진이 받는다(충돌·병합 규칙이 한 곳에만 있도록).
 * 연결이 끊기면 주기적 동기화가 대신한다.
 */
export function watchTrip(client: SupabaseClient, tripId: string, onChange: () => void): () => void {
  let channel = client.channel(`trip:${tripId}`)
  for (const t of WATCHED) {
    channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: t === 'trips' ? `id=eq.${tripId}` : `trip_id=eq.${tripId}` }, () => onChange())
  }
  channel.subscribe()
  return () => { void client.removeChannel(channel) }
}

/** 이 기기의 고정 식별자. 저장소를 쓸 수 없으면 실행마다 새로 만든다(동기화 자체에는 영향 없음). */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem('tm.deviceId')
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('tm.deviceId', id) }
    return id
  } catch { return (getDeviceId as unknown as { fallback?: string }).fallback ??= crypto.randomUUID() }
}

/** Supabase(PostgREST + sync_apply RPC) 어댑터. 실제 서버 연동은 Supabase 프로젝트와 로그인 설정 후에 검증할 수 있다. */
export function createSupabaseRemote(client: SupabaseClient, getUserId: () => string): RemoteAdapter {
  return {
    userId: getUserId,
    clientId: getDeviceId,
    async push(req: PushRequest): Promise<PushResult> {
      const { data, error } = await client.rpc('sync_apply', { p_table: req.table, p_id: req.id, p_op: req.op, p_base_version: req.baseVersion, p_fields: req.fields, p_client: req.clientId })
      if (error) throw isNetwork(error.message) ? new SyncNetworkError() : new SyncRejected(error.message)
      return data as PushResult
    },
    async listTrips(): Promise<string[]> {
      const { data, error } = await client.from('trips').select('id').is('deleted_at', null)   // RLS: 참여 중인 여행만
      if (error) throw isNetwork(error.message) ? new SyncNetworkError() : new SyncRejected(error.message)
      return (data ?? []).map((r) => String(r.id))
    },
    async access(tripId: string): Promise<'ok' | 'denied'> {
      // RLS: 참여 중인 멤버(또는 소유자)가 아니면 여행 행이 보이지 않는다
      const { data, error } = await client.from('trips').select('id').eq('id', tripId).maybeSingle()
      if (error) throw isNetwork(error.message) ? new SyncNetworkError() : new SyncRejected(error.message)
      return data ? 'ok' : 'denied'
    },
    async pull(table: string, tripId: string, sinceMs: number): Promise<RemoteRow[]> {
      const out: RemoteRow[] = []
      for (let from = 0; ; from += PAGE) {
        let q = client.from(table).select('*').gt('updated_at', new Date(sinceMs).toISOString()).order('updated_at', { ascending: true }).order('id', { ascending: true }).range(from, from + PAGE - 1)
        q = table === 'trips' ? q.eq('id', tripId) : q.eq('trip_id', tripId)
        const { data, error } = await q
        if (error) throw isNetwork(error.message) ? new SyncNetworkError() : new SyncRejected(error.message)
        out.push(...(data as RemoteRow[]))
        if (!data || data.length < PAGE) break
      }
      return out
    },
  }
}
