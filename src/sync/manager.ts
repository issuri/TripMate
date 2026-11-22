// 자동 동기화 관리자: 인터넷 복구 시, 주기적으로, 로컬 변경이 생긴 직후(잠깐 모아서) 동기화한다.
import { liveQuery } from 'dexie'
import { db } from '../db/local'
import { syncTrip, pendingCount, type RemoteAdapter, type SyncReport } from './engine'

export type SyncStatus = 'unconfigured' | 'signed_out' | 'idle' | 'syncing' | 'offline' | 'error'
export interface SyncState { status: SyncStatus; lastReport: SyncReport | null }

type Listener = (s: SyncState) => void

/**
 * remote 가 null 이면(서버 미설정 또는 로그아웃) 동기화하지 않고 로컬 전용으로 동작한다.
 * 동기화 요청은 db 쪽에서 한 줄로 직렬화되므로 여기서 여러 번 불러도 중복 전송되지 않는다.
 */
export function createSyncManager(getRemote: () => RemoteAdapter | null, opts: { intervalMs?: number; debounceMs?: number; afterTrip?: (tripId: string) => Promise<unknown>; discover?: (remote: RemoteAdapter) => Promise<unknown> } = {}) {
  let state: SyncState = { status: 'idle', lastReport: null }
  const listeners = new Set<Listener>()
  const set = (s: Partial<SyncState>) => { state = { ...state, ...s }; listeners.forEach((l) => l(state)) }
  let timer: ReturnType<typeof setTimeout> | null = null

  let running = false
  async function syncAll(): Promise<void> {
    if (running) return // 이전 동기화가 끝나지 않았는데 주기/이벤트가 겹쳐도 쌓이지 않게 한다
    running = true
    try { await syncAllOnce() } finally { running = false }
  }
  async function syncAllOnce(): Promise<void> {
    const remote = getRemote()
    if (!remote) return set({ status: 'unconfigured' })
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return set({ status: 'offline' })
    set({ status: 'syncing' })
    // 초대받았거나 다른 기기에서 만든 여행이 서버에 있으면 먼저 내려받는다(실패해도 이미 있는 여행의 동기화는 계속)
    await opts.discover?.(remote).catch(() => undefined)
    // 삭제한 여행은 삭제가 서버에 전달될 때까지만(보낼 변경이 남아 있을 때만) 동기화한다
    const trips = await db.trips.toArray()
    const ids: string[] = []
    for (const t of trips) if (t.deletedAt === null || (await pendingCount(t.id, db)) > 0) ids.push(t.id)
    let last: SyncReport | null = null
    let net = false
    for (const id of ids) {
      last = await syncTrip(id, remote, db)
      if (last.error && /네트워크/.test(last.error)) { net = true; break }
      await opts.afterTrip?.(id).catch(() => undefined) // 예: 동행자 목록 새로고침(실패해도 동기화 결과에는 영향 없음)
    }
    set({ status: net ? 'offline' : last?.error ? 'error' : 'idle', lastReport: last })
  }

  const schedule = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void syncAll() }, ms) }

  function start() {
    const onOnline = () => schedule(500)
    const onOffline = () => set({ status: 'offline' })
    addEventListener('online', onOnline); addEventListener('offline', onOffline)
    const iv = setInterval(() => void syncAll(), opts.intervalMs ?? 60_000)
    // 로컬 변경 큐가 늘어나면 잠깐 모아서 동기화
    const sub = liveQuery(() => db.outbox.count()).subscribe({ next: (n) => { if (n > 0) schedule(opts.debounceMs ?? 2000) } })
    schedule(300)
    return () => { removeEventListener('online', onOnline); removeEventListener('offline', onOffline); clearInterval(iv); sub.unsubscribe(); if (timer) clearTimeout(timer) }
  }

  return { start, syncAll, requestSync: (ms = 300) => schedule(ms), getState: () => state, subscribe: (l: Listener) => { listeners.add(l); return () => { listeners.delete(l) } }, pendingCount }
}
