import { liveQuery } from 'dexie'
import { useEffect, useState } from 'react'
import { db } from '../db/local'
import { createSyncManager, type SyncState } from './manager'
import { createSupabase, createSupabaseRemote, watchTrip } from './remote'
import { discoverTrips, type RemoteAdapter } from './engine'

/** Supabase 프로젝트가 설정되어 있는지(.env.local). 없으면 앱은 로컬 전용으로 동작한다. */
export const supabase = createSupabase()
export const syncConfigured = !!supabase

let remote: RemoteAdapter | null = null
let userId: string | null = null
/** 로그인/로그아웃 시 auth.ts 가 호출한다. null 이면 동기화를 끈다. */
export function setSignedInUser(id: string | null) {
  userId = id
  remote = supabase && id ? createSupabaseRemote(supabase, () => userId!) : null
}
export const getRemote = () => remote

export const syncManager = createSyncManager(() => remote, {
  discover: (r) => discoverTrips(r),
})

/**
 * 서버에 있는 여행마다 실시간 변경 알림을 구독한다(다른 사람이 고치면 바로 동기화). 로그인한 동안만.
 * 연결이 끊겨도 주기적 동기화가 같은 일을 하므로 실시간은 "빨리 반영"을 위한 보조 수단이다.
 */
export function startRealtime(): () => void {
  if (!supabase) return () => undefined
  const client = supabase
  const watching = new Map<string, () => void>()
  const sub = liveQuery(() => db.trips.filter((t) => t.deletedAt === null && t.version > 0).primaryKeys()).subscribe({
    next: (ids) => {
      if (!remote) { watching.forEach((off) => off()); watching.clear(); return }
      for (const id of ids) if (!watching.has(id)) watching.set(id, watchTrip(client, id, () => syncManager.requestSync(300)))
      for (const [id, off] of [...watching]) if (!ids.includes(id)) { off(); watching.delete(id) }
    },
  })
  return () => { sub.unsubscribe(); watching.forEach((off) => off()); watching.clear() }
}

export function useSyncState(): SyncState & { configured: boolean; signedIn: boolean } {
  const [s, setS] = useState<SyncState>(syncManager.getState())
  useEffect(() => syncManager.subscribe(setS), [])
  const status = !syncConfigured ? 'unconfigured' : !remote ? 'signed_out' : s.status
  return { ...s, status, configured: syncConfigured, signedIn: !!remote }
}
