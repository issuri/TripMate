import { useEffect, useState } from 'react'
import { createSyncManager, type SyncState } from './manager'
import { createSupabase, createSupabaseRemote } from './remote'
import type { RemoteAdapter } from './engine'

/** Supabase 프로젝트가 설정되어 있는지(.env.local). 없으면 앱은 로컬 전용으로 동작한다. */
export const supabase = createSupabase()
export const syncConfigured = !!supabase

let remote: RemoteAdapter | null = null
let userId: string | null = null
/** 로그인 후 호출한다(로그인 화면은 6단계에서 추가). null 이면 동기화를 끈다. */
export function setSignedInUser(id: string | null) {
  userId = id
  remote = supabase && id ? createSupabaseRemote(supabase, () => userId!) : null
}
export const getRemote = () => remote

export const syncManager = createSyncManager(() => remote)

export function useSyncState(): SyncState & { configured: boolean; signedIn: boolean } {
  const [s, setS] = useState<SyncState>(syncManager.getState())
  useEffect(() => syncManager.subscribe(setS), [])
  const status = !syncConfigured ? 'unconfigured' : !remote ? 'signed_out' : s.status
  return { ...s, status, configured: syncConfigured, signedIn: !!remote }
}
