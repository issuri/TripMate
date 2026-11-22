import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { db } from '../db/local'
import type { Trip } from '../db/types'
import { discardRejected, downloadTrip, MAX_ATTEMPTS, pendingCount, removeOfflineCopy, resolveConflict, syncTrip } from '../sync/engine'
import { getRemote, useSyncState } from '../sync/runtime'
import { btnGhost, btnPrimary, Card } from './kit'

const fmtTime = (ms: number | null | undefined) => (ms ? new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms) : '아직 없음')
const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)
const FIELD_LABEL: Record<string, string> = { title: '제목', memo: '메모', startTime: '시작 시간', endTime: '종료 시간', name: '이름', dayNumber: '날짜', quantity: '수량', expectedPriceMinor: '예상 가격', purpose: '목적', city: '도시', country: '국가', startDate: '시작일', endDate: '종료일' }
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(비어 있음)' : String(v))

export default function OfflinePage() {
  const trip = useOutletContext<Trip>()
  const nav = useNavigate()
  const sync = useSyncState()
  const [online, setOnline] = useState(navigator.onLine)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [storage, setStorage] = useState<{ usage: number; quota: number; persisted: boolean | null } | null>(null)

  const meta = useLiveQuery(() => db.syncMeta.get(trip.id), [trip.id])
  const conflicts = useLiveQuery(() => db.conflicts.where('tripId').equals(trip.id).toArray(), [trip.id]) ?? []
  const counts = useLiveQuery(async () => {
    const live = <T extends { deletedAt: number | null }>(rows: T[]) => rows.filter((r) => !r.deletedAt)
    const [items, places, shop, chk] = await Promise.all([
      db.itineraryItems.where('tripId').equals(trip.id).toArray(), db.places.where('tripId').equals(trip.id).toArray(),
      db.shoppingItems.where('tripId').equals(trip.id).toArray(), db.checklistItems.where('tripId').equals(trip.id).toArray(),
    ])
    return { items: live(items).length, places: live(places).length, shop: live(shop).length, chk: live(chk).length, bytes: JSON.stringify([items, places, shop, chk, trip]).length }
  }, [trip.id])
  const pending = useLiveQuery(() => pendingCount(trip.id), [trip.id, sync.lastReport]) ?? 0
  const stuck = useLiveQuery(async () => (await db.outbox.toArray()).filter((e) => (e.attempts ?? 0) >= MAX_ATTEMPTS), []) ?? []

  useEffect(() => {
    const u = () => setOnline(navigator.onLine)
    addEventListener('online', u); addEventListener('offline', u)
    return () => { removeEventListener('online', u); removeEventListener('offline', u) }
  }, [])
  useEffect(() => {
    void (async () => {
      const est = await navigator.storage?.estimate?.().catch(() => undefined)
      const persisted = await navigator.storage?.persisted?.().catch(() => null)
      setStorage({ usage: est?.usage ?? 0, quota: est?.quota ?? 0, persisted: persisted ?? null })
    })()
  }, [meta?.lastSyncAt])

  const remote = getRemote()
  const serverKnows = trip.version > 0 || !!meta?.lastSyncAt
  const canSync = sync.configured && sync.signedIn && online
  const why = !sync.configured ? '서버(Supabase)가 아직 설정되지 않아 이 기기에만 저장돼요.' : !sync.signedIn ? '로그인이 필요해요.' : !online ? '인터넷에 연결되면 자동으로 동기화돼요.' : ''

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label); setMsg(null)
    try { setMsg({ ok: true, text: await fn() }) } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(null) }
  }
  const doSync = () => run('sync', async () => { const r = await syncTrip(trip.id, remote!); if (r.error) throw new Error(r.error); return r.conflicts ? `동기화했어요. 충돌 ${r.conflicts}건이 있어요.` : '동기화했어요.' })
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null)
  const doDownload = () => run('download', async () => {
    try { const r = await downloadTrip(trip.id, remote!, undefined, (done, total, label) => setProgress({ done, total, label })); if (r.error) throw new Error(r.error); return '서버의 최신 여행 정보를 이 기기에 저장했어요.' } finally { setProgress(null) }
  })
  const doDiscard = () => run('discard', async () => { if (!confirm('서버가 거부한 변경을 버리고 서버의 값으로 되돌릴까요?')) return '취소했어요.'; const r = await discardRejected(trip.id, remote!); if (r.error) throw new Error(r.error); return '서버의 값으로 되돌렸어요.' })
  const doRemove = () => run('remove', async () => {
    if (!confirm('이 기기에 저장된 이 여행의 오프라인 데이터를 삭제할까요? 서버에는 남아 있고 다시 내려받을 수 있어요.')) return '취소했어요.'
    await removeOfflineCopy(trip.id, { synced: serverKnows })
    nav('/', { replace: true }); return ''
  })

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">오프라인 저장</h2>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${online ? 'bg-mint/15 text-mint' : 'bg-line text-ink-2'}`}>{online ? '온라인' : '오프라인'}</span>
        </div>
        <p className="mt-2 text-sm text-ink-2">일정, 장소, 쇼핑 리스트, 준비물, 메모는 이 기기에 저장돼 있어서 인터넷이 없어도 보고 고칠 수 있어요. 인터넷이 다시 연결되면 변경한 내용이 서버로 올라가요.</p>
        <dl className="num mt-4 grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-ink-2">저장 상태</dt><dd className="font-bold">{!sync.configured ? '이 기기에만 저장' : pending > 0 ? `동기화 대기 ${pending}건` : serverKnows ? '서버와 동일' : '아직 서버에 없음'}</dd></div>
          <div><dt className="text-xs text-ink-2">마지막 동기화</dt><dd className="font-bold">{fmtTime(meta?.lastSyncAt)}</dd></div>
          <div><dt className="text-xs text-ink-2">전체 저장(내려받기)</dt><dd className="font-bold">{meta?.offlineSavedAt ? fmtTime(meta.offlineSavedAt) : '안 함'}</dd></div>
          <div><dt className="text-xs text-ink-2">이 여행 데이터 크기</dt><dd className="font-bold">{counts ? fmtBytes(counts.bytes) : '…'}</dd></div>
        </dl>
        {counts && <p className="mt-3 text-sm text-ink-2">일정 {counts.items} · 장소 {counts.places} · 쇼핑 {counts.shop} · 준비물 {counts.chk}</p>}
        {storage && <p className="mt-1 text-xs text-ink-3">기기 저장공간 {fmtBytes(storage.usage)} 사용{storage.quota ? ` / ${fmtBytes(storage.quota)}` : ''} · 자동 삭제 보호 {storage.persisted ? '켜짐' : storage.persisted === false ? '꺼짐(홈 화면에 추가하면 더 안전해요)' : '확인 불가'}</p>}
        {meta?.lastError && <p className="mt-3 rounded-2xl bg-danger/10 p-3 text-sm text-danger" role="alert">마지막 동기화 오류: {meta.lastError}</p>}
      </Card>

      {conflicts.length > 0 && (
        <Card>
          <h2 className="text-base font-bold">확인이 필요한 충돌 {conflicts.length}건</h2>
          <p className="mt-1 text-sm text-ink-2">같은 항목을 다른 사람과 동시에 고쳤어요. 어느 쪽을 쓸지 골라 주세요. 고르기 전에는 아무것도 덮어쓰지 않아요.</p>
          <ul className="mt-3 space-y-3">
            {conflicts.map((c) => (
              <li key={c.id} className="rounded-2xl bg-paper p-3">
                <p className="font-semibold">{c.title || '(이름 없음)'} {c.kind === 'field' && <span className="font-normal text-ink-2">· {FIELD_LABEL[c.field] ?? c.field}</span>}</p>
                {c.kind === 'deleted'
                  ? <><p className="mt-1 text-sm text-ink-2">다른 사용자가 이 항목을 삭제해서 내 수정은 적용되지 않았어요.</p><button className={`${btnGhost} mt-2 w-full`} onClick={() => resolveConflict(c.id, 'theirs')}>확인</button></>
                  : <>
                      <p className="mt-1 text-sm">내 값: <b>{show(c.localValue)}</b></p>
                      <p className="text-sm">상대 값: <b>{show(c.remoteValue)}</b></p>
                      <div className="mt-2 flex gap-2">
                        <button className={`${btnGhost} flex-1`} onClick={() => resolveConflict(c.id, 'theirs')}>상대 값 사용</button>
                        <button className={`${btnPrimary} flex-1`} onClick={() => resolveConflict(c.id, 'mine')}>내 값 사용</button>
                      </div>
                    </>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {stuck.length > 0 && (
        <Card>
          <h2 className="text-base font-bold">서버가 받지 않은 변경 {stuck.length}건</h2>
          <p className="mt-1 text-sm text-ink-2">권한이 없거나 값이 올바르지 않아 서버에 반영되지 않았어요. 버리면 서버에 있는 값으로 되돌아가요.</p>
          <p className="mt-1 text-xs text-ink-3">{stuck[0].lastError}</p>
          <button className={`${btnGhost} mt-3 w-full`} disabled={!canSync || busy !== null} onClick={doDiscard}>버리고 서버 값으로 되돌리기</button>
        </Card>
      )}

      <Card className="space-y-2">
        <button className={`${btnPrimary} w-full`} disabled={!canSync || busy !== null} onClick={doSync}>{busy === 'sync' ? '동기화 중…' : '지금 동기화'}</button>
        <button className={`${btnGhost} w-full`} disabled={!canSync || busy !== null} onClick={doDownload}>{busy === 'download' ? `내려받는 중… ${progress ? `${progress.label} (${Math.min(progress.done + 1, progress.total)}/${progress.total})` : ''}` : '서버에서 전체 다시 내려받기'}</button>
        {progress && <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={progress.done} aria-valuemax={progress.total}><div className="h-full rounded-full bg-signal transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>}
        {why && <p className="px-1 text-xs text-ink-3">{why}</p>}
        {msg && <p className={`px-1 text-sm ${msg.ok ? 'text-mint' : 'text-danger'}`} role="status">{msg.text}</p>}
      </Card>

      <Card>
        <h2 className="text-base font-bold">오프라인에서 되는 것과 안 되는 것</h2>
        <ul className="mt-2 space-y-1 text-sm">
          <li>✅ 일정·장소 이름/주소/좌표·방문 순서·메모 보기와 수정</li>
          <li>✅ 쇼핑 리스트 보기·체크, 일정 완료 체크, 준비물 체크</li>
          <li>⚠️ 앱 안 알림은 앱이 열려 있을 때만 울려요</li>
          <li>🚫 지도 화면, 장소 검색, Google 지도 길찾기는 인터넷이 필요해요</li>
        </ul>
      </Card>

      <Card>
        <h2 className="text-base font-bold">이 기기의 저장 데이터 삭제</h2>
        <p className="mt-1 text-sm text-ink-2">{serverKnows ? '서버에는 남아 있어서 나중에 다시 내려받을 수 있어요. 아직 서버에 올리지 않은 변경이 있으면 삭제할 수 없어요.' : '이 여행은 아직 서버에 저장되지 않아 이 기기에만 있어요. 삭제하면 복구할 수 없으므로 삭제를 막아 두었어요.'}</p>
        <button className={`${btnGhost} mt-3 w-full text-danger`} disabled={busy !== null} onClick={doRemove}>저장 데이터 삭제</button>
      </Card>
    </div>
  )
}
