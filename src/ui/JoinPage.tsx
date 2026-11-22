import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { downloadTrip } from '../sync/engine'
import { getRemote, sharing, syncConfigured, syncManager } from '../sync/runtime'
import { useAuth } from '../sync/auth'
import { extractInviteCode, refreshMembers, toSharingError } from '../sync/sharing'
import { btnGhost, btnPrimary, Card, Field, input } from './kit'

const PENDING = 'tm.pendingInvite'
const readPending = () => { try { return sessionStorage.getItem(PENDING) } catch { return null } }
const writePending = (v: string | null) => { try { if (v) sessionStorage.setItem(PENDING, v); else sessionStorage.removeItem(PENDING) } catch { /* 저장소를 못 쓰는 환경은 무시 */ } }

/** 초대 링크(/join#코드) 또는 코드 직접 입력으로 여행에 참여한다. 로그인이 필요하다. */
export default function JoinPage() {
  const auth = useAuth()
  const nav = useNavigate()
  const [text, setText] = useState(() => extractInviteCode(location.hash) ?? readPending() ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const used = useRef(false)

  // 링크로 들어왔는데 로그인 전이면, 코드를 잠깐 보관했다가 로그인 후 이어서 진행한다(코드는 URL 해시에만 있었으므로 서버 로그에 남지 않는다)
  useEffect(() => {
    const c = extractInviteCode(location.hash)
    if (c) { writePending(c); history.replaceState(null, '', '/join') } // 주소창/기록에 코드가 남지 않게 지운다
  }, [])

  const join = async () => {
    if (busy || used.current || !sharing) return
    setBusy(true); setErr(null)
    try {
      const { tripId } = await sharing.join(text)
      used.current = true; writePending(null)
      const remote = getRemote()
      // 참여는 이미 끝났다. 내려받기가 실패해도 여행은 다음 동기화 때 자동으로 목록에 나타난다(코드는 다시 쓸 필요 없음).
      const r = remote ? await downloadTrip(tripId, remote) : null
      if (r && !r.error) { await refreshMembers(tripId, sharing); nav(`/trips/${tripId}`, { replace: true }); return }
      setErr('참여는 완료됐어요. 여행 정보를 아직 내려받지 못했어요. 인터넷이 연결되면 자동으로 내려받아 여행 목록에 나타나요.')
      syncManager.requestSync(1000)
    } catch (e) { setErr(toSharingError(e).message) } finally { setBusy(false) }
  }

  if (!syncConfigured) {
    return (
      <main className="mx-auto max-w-md space-y-4 px-4 pt-[calc(2rem+env(safe-area-inset-top))]">
        <h1 className="text-[28px] font-extrabold tracking-tight">여행 참여</h1>
        <Card><p className="font-semibold">서버가 아직 설정되지 않았어요</p><p className="mt-2 text-sm text-ink-2">동행자 공유를 쓰려면 서버(Supabase) 설정이 필요해요.</p></Card>
        <Link to="/" className={`${btnGhost} block text-center`}>돌아가기</Link>
      </main>
    )
  }
  if (auth.status === 'loading') return <p className="p-6 text-ink-2">불러오는 중…</p>
  if (auth.status !== 'signed_in') {
    return (
      <main className="mx-auto max-w-md space-y-4 px-4 pt-[calc(2rem+env(safe-area-inset-top))]">
        <h1 className="text-[28px] font-extrabold tracking-tight">여행 참여</h1>
        <Card><p className="font-semibold">먼저 로그인해 주세요</p><p className="mt-2 text-sm text-ink-2">초대받은 사람만 여행에 참여할 수 있어서 로그인이 필요해요. 로그인 후 이 화면으로 돌아와요.</p></Card>
        <Link to="/login?next=/join" className={`${btnPrimary} block text-center`}>로그인하기</Link>
      </main>
    )
  }
  const code = extractInviteCode(text)
  return (
    <main className="mx-auto max-w-md space-y-4 px-4 pt-[calc(2rem+env(safe-area-inset-top))]">
      <h1 className="text-[28px] font-extrabold tracking-tight">여행 참여</h1>
      <Card className="space-y-3">
        <Field label="초대 코드 또는 초대 링크"><input className={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="XXXX-XXXX-XXXX" autoCapitalize="characters" autoComplete="off" /></Field>
        {err && <p className="rounded-2xl bg-danger/10 p-3 text-sm text-danger" role="alert">{err}</p>}
        <button className={`${btnPrimary} w-full`} disabled={busy || !code} onClick={join}>{busy ? '참여하는 중…' : '이 여행에 참여하기'}</button>
        {text.trim() && !code && <p className="px-1 text-xs text-ink-3">코드 형식은 XXXX-XXXX-XXXX 예요.</p>}
      </Card>
      <p className="px-1 text-xs text-ink-3">참여하면 일정, 장소, 쇼핑 리스트, 준비물을 함께 보고 고칠 수 있어요. 여행 기본 정보는 관리자만 고칠 수 있어요.</p>
    </main>
  )
}
