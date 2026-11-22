import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useOutletContext } from 'react-router-dom'
import { db } from '../db/local'
import type { Trip } from '../db/types'
import { discardLocalCopy, syncTrip } from '../sync/engine'
import { getRemote, sharing, syncConfigured } from '../sync/runtime'
import { useAuth } from '../sync/auth'
import { can, inviteLink, inviteMessage, myRole, refreshMembers, toSharingError, type InviteInfo } from '../sync/sharing'
import { btnGhost, btnPrimary, Card } from './kit'

const fmt = (ms: number) => new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms)
const EXPIRY: [string, number][] = [['1일', 24], ['3일', 72], ['7일', 168], ['30일', 720]]

export default function SharePage() {
  const trip = useOutletContext<Trip>()
  const auth = useAuth()
  const nav = useNavigate()
  const members = (useLiveQuery(() => db.members.where('tripId').equals(trip.id).toArray(), [trip.id]) ?? []).sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || Number(b.role === 'admin') - Number(a.role === 'admin') || a.joinedAt - b.joinedAt)
  const meta = useLiveQuery(() => db.syncMeta.get(trip.id), [trip.id])
  const role = useLiveQuery(() => myRole(trip.id, undefined, auth.userId), [trip.id, members.length, auth.userId]) ?? 'admin'
  const [online, setOnline] = useState(navigator.onLine)
  const [invites, setInvites] = useState<InviteInfo[]>([])
  const [fresh, setFresh] = useState<string | null>(null)
  const [hours, setHours] = useState(168)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const serverKnows = trip.version > 0 || !!meta?.lastSyncAt
  const signedIn = auth.status === 'signed_in'
  const ready = syncConfigured && signedIn && serverKnows && online
  const admin = can.manageMembers(role)

  useEffect(() => {
    const u = () => setOnline(navigator.onLine)
    addEventListener('online', u); addEventListener('offline', u)
    return () => { removeEventListener('online', u); removeEventListener('offline', u) }
  }, [])

  const reload = useCallback(async () => {
    if (!sharing || !ready) return
    const r = await refreshMembers(trip.id, sharing)
    if (r === 'ok' && admin) {
      try { const now = Date.now(); setInvites((await sharing.listInvites(trip.id)).filter((i) => !i.revoked && i.expiresAt > now && i.usedCount < i.maxUses)) } catch { /* 목록은 보조 정보 */ }
    }
  }, [trip.id, ready, admin])
  useEffect(() => { void reload() }, [reload])

  const run = async (label: string, fn: () => Promise<string | void>) => {
    if (busy) return
    setBusy(label); setMsg(null)
    try { const t = await fn(); if (t) setMsg({ ok: true, text: t }); await reload() } catch (e) { setMsg({ ok: false, text: toSharingError(e).message }) } finally { setBusy(null) }
  }

  const shareText = fresh ? inviteMessage(trip.name, inviteLink(location.origin, fresh), fresh) : ''
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setMsg({ ok: true, text: '복사했어요.' }) }
    catch { setMsg({ ok: false, text: '복사하지 못했어요. 직접 선택해서 복사해 주세요.' }) }
  }
  const shareNative = async () => {
    try { if (navigator.share) await navigator.share({ title: `${trip.name} 초대`, text: shareText }); else await copy(shareText) } catch { /* 사용자가 공유창을 닫음 */ }
  }

  // ───── 사용할 수 없는 상태 안내 ─────
  if (!syncConfigured) return <Gate title="서버가 아직 설정되지 않았어요" body="동행자 공유는 서버(Supabase)가 필요해요. 설정 전에는 이 기기에서만 여행을 관리할 수 있어요." />
  if (!signedIn) return <Gate title="로그인이 필요해요" body="초대받은 사람만 접근하도록 로그인한 사용자끼리만 공유할 수 있어요." action={<Link to={`/login?next=${encodeURIComponent(`/trips/${trip.id}/share`)}`} className={`${btnPrimary} block text-center`}>로그인하기</Link>} />
  if (!serverKnows) {
    return <Gate title="먼저 서버에 올려야 해요" body="이 여행은 아직 이 기기에만 있어요. 서버에 올린 뒤에 동행자를 초대할 수 있어요."
      action={<button className={`${btnPrimary} w-full`} disabled={busy !== null || !online} onClick={() => run('upload', async () => { const r = await syncTrip(trip.id, getRemote()!); if (r.error) throw new Error(r.error); return '서버에 올렸어요.' })}>{busy === 'upload' ? '올리는 중…' : '서버에 올리기'}</button>} />
  }

  return (
    <div className="space-y-4">
      {!online && <p className="rounded-2xl bg-line p-3 text-sm text-ink-2">오프라인이에요. 동행자 목록은 마지막으로 저장된 상태이고, 초대와 권한 변경은 인터넷이 연결되어야 해요.</p>}

      <Card>
        <h2 className="text-base font-bold">동행자 {members.filter((m) => m.status === 'active').length}명</h2>
        <ul className="mt-3 divide-y divide-line">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-3">
              <div className="grid h-10 w-10 shrink-0 place-content-center rounded-full bg-signal-soft font-bold text-signal">{(m.displayName || '?').slice(0, 1)}</div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{m.displayName || '(이름 없음)'}{m.isMe && <span className="font-normal text-ink-2"> · 나</span>}</p>
                <p className="text-xs text-ink-2">{m.status === 'left' ? '나감' : m.status === 'removed' ? '내보냄' : m.role === 'admin' ? '관리자' : '동행자'}</p>
              </div>
              {admin && online && m.status === 'active' && !m.isMe && (
                <div className="flex shrink-0 gap-1">
                  <button className="rounded-full bg-paper px-3 py-2 text-xs font-semibold" disabled={busy !== null}
                    onClick={() => run('role', async () => { await sharing!.setRole(trip.id, m.userId, m.role === 'admin' ? 'member' : 'admin'); return m.role === 'admin' ? '동행자로 바꿨어요.' : '관리자로 지정했어요.' })}>{m.role === 'admin' ? '관리자 해제' : '관리자로'}</button>
                  <button className="rounded-full bg-danger/10 px-3 py-2 text-xs font-semibold text-danger" disabled={busy !== null}
                    onClick={() => confirm(`${m.displayName || '이 사용자'}님을 내보낼까요? 바로 이 여행에 접근할 수 없게 돼요.`) && run('remove', async () => { await sharing!.removeMember(trip.id, m.userId); return '내보냈어요.' })}>내보내기</button>
                </div>
              )}
            </li>
          ))}
          {members.length === 0 && <li className="py-3 text-sm text-ink-2">동행자 목록을 불러오는 중이에요.</li>}
        </ul>
        {!admin && <p className="mt-2 text-xs text-ink-3">초대와 권한 관리는 관리자만 할 수 있어요. 일정·쇼핑·준비물은 함께 고칠 수 있어요.</p>}
      </Card>

      {admin && (
        <Card className="space-y-3">
          <h2 className="text-base font-bold">동행자 초대</h2>
          <div className="flex items-center gap-2">
            <label className="text-sm text-ink-2" htmlFor="expiry">유효 기간</label>
            <select id="expiry" className="rounded-xl bg-paper px-3 py-2 text-sm font-semibold" value={hours} onChange={(e) => setHours(Number(e.target.value))}>{EXPIRY.map(([l, h]) => <option key={h} value={h}>{l}</option>)}</select>
            <span className="text-xs text-ink-3">최대 5명까지 사용</span>
          </div>
          <button className={`${btnPrimary} w-full`} disabled={!online || busy !== null} onClick={() => run('invite', async () => { setFresh(await sharing!.createInvite(trip.id, { hours, maxUses: 5 })) })}>{busy === 'invite' ? '만드는 중…' : '초대 코드 만들기'}</button>
          {fresh && (
            <div className="rounded-2xl bg-ink p-4 text-white">
              <p className="text-xs text-white/60">초대 코드 · 이 화면을 닫으면 다시 볼 수 없어요</p>
              <p className="num mt-1 select-all text-3xl font-extrabold tracking-wider">{fresh}</p>
              <p className="mt-2 break-all text-xs text-white/60">{inviteLink(location.origin, fresh)}</p>
              <div className="mt-3 flex gap-2">
                <button className="flex-1 rounded-xl bg-white px-3 py-2.5 text-sm font-semibold text-ink" onClick={shareNative}>공유하기</button>
                <button className="flex-1 rounded-xl bg-white/15 px-3 py-2.5 text-sm font-semibold" onClick={() => copy(shareText)}>복사</button>
              </div>
            </div>
          )}
          {invites.length > 0 && (
            <ul className="divide-y divide-line">
              {invites.map((i) => (
                <li key={i.id} className="num flex items-center gap-3 py-2.5 text-sm">
                  <span className="flex-1">사용 {i.usedCount}/{i.maxUses} · {fmt(i.expiresAt)}까지</span>
                  <button className="rounded-full bg-paper px-3 py-1.5 text-xs font-semibold" disabled={busy !== null} onClick={() => run('revoke', async () => { await sharing!.revokeInvite(i.id); return '초대를 취소했어요.' })}>취소</button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {msg && <p className={`rounded-2xl p-3 text-sm ${msg.ok ? 'bg-mint/10 text-mint' : 'bg-danger/10 text-danger'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}

      <Card className="space-y-2">
        <h2 className="text-base font-bold">공유 관리</h2>
        {admin
          ? <button className={`${btnGhost} w-full text-danger`} disabled={!online || busy !== null} onClick={() => confirm('공유를 종료할까요? 나를 뺀 모든 동행자가 내보내지고 모든 초대가 취소돼요. 여행 데이터는 나에게 남아요.') && run('end', async () => { const n = await sharing!.endSharing(trip.id); return `공유를 종료했어요. 동행자 ${n}명이 내보내졌어요.` })}>공유 종료</button>
          : null}
        <button className={`${btnGhost} w-full`} disabled={!online || busy !== null} onClick={() => confirm('이 여행에서 나갈까요? 나가면 이 여행에 접근할 수 없고 이 기기의 사본도 삭제돼요.') && run('leave', async () => { await sharing!.leave(trip.id); await discardLocalCopy(trip.id); nav('/', { replace: true }) })}>여행에서 나가기</button>
        <p className="px-1 text-xs text-ink-3">마지막 관리자는 나갈 수 없어요. 먼저 다른 사람을 관리자로 지정하거나 공유를 종료하세요.</p>
      </Card>
    </div>
  )
}

function Gate({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <Card className="space-y-3"><h2 className="text-base font-bold">{title}</h2><p className="text-sm text-ink-2">{body}</p>{action}</Card>
}
