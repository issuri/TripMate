import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { sendLoginCode, signOut, useAuth, verifyLoginCode } from '../sync/auth'
import { syncConfigured } from '../sync/runtime'
import { btnGhost, btnPrimary, Card, Field, input } from './kit'

/** 로그인 없이도 앱은 쓸 수 있다. 공유와 서버 동기화에만 필요하다. */
export default function LoginPage() {
  const auth = useAuth()
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const next = (() => { const n = sp.get('next') ?? '/'; return n.startsWith('/') && !n.startsWith('//') ? n : '/' })() // 외부 주소로 보내지 않는다
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setMsg(null)
    try { await fn() } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }

  if (!syncConfigured) {
    return (
      <main className="mx-auto max-w-md space-y-4 px-4 pt-[calc(2rem+env(safe-area-inset-top))]">
        <h1 className="text-[28px] font-extrabold tracking-tight">로그인</h1>
        <Card>
          <p className="font-semibold">서버가 아직 설정되지 않았어요</p>
          <p className="mt-2 text-sm text-ink-2">지금은 이 기기에만 저장되는 로컬 모드예요. 동행자 공유와 여러 기기 동기화를 쓰려면 Supabase 프로젝트를 만들고 <code>.env.local</code>에 <code>VITE_SUPABASE_URL</code>과 <code>VITE_SUPABASE_ANON_KEY</code>를 넣어야 해요.</p>
        </Card>
        <button className={`${btnGhost} w-full`} onClick={() => nav('/')}>돌아가기</button>
      </main>
    )
  }

  if (auth.status === 'signed_in') {
    return (
      <main className="mx-auto max-w-md space-y-4 px-4 pt-[calc(2rem+env(safe-area-inset-top))]">
        <h1 className="text-[28px] font-extrabold tracking-tight">로그인됨</h1>
        <Card><p className="text-sm text-ink-2">계정</p><p className="font-bold">{auth.email}</p></Card>
        <button className={`${btnPrimary} w-full`} onClick={() => nav(next, { replace: true })}>계속하기</button>
        <button className={`${btnGhost} w-full`} onClick={() => run(async () => { await signOut() })}>로그아웃</button>
        <p className="px-1 text-xs text-ink-3">로그아웃해도 이 기기에 저장된 여행 데이터는 그대로 남아요. 서버 동기화와 공유만 멈춰요.</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-md space-y-4 px-4 pt-[calc(2rem+env(safe-area-inset-top))]">
      <h1 className="text-[28px] font-extrabold tracking-tight">로그인</h1>
      <p className="px-1 text-sm text-ink-2">이메일로 받은 숫자 코드를 입력하면 로그인돼요. 비밀번호는 필요 없어요.</p>
      <Card className="space-y-3">
        <Field label="이메일"><input className={input} type="email" inputMode="email" autoComplete="email" value={email} disabled={sent} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></Field>
        {sent && <>
          <Field label="이메일로 받은 코드"><input className={input} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="숫자 6자리" autoFocus /></Field>
          <Field label="동행자에게 보일 이름 (처음 로그인할 때)"><input className={input} value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder="예: 민수" /></Field>
        </>}
        {msg && <p className={`rounded-2xl p-3 text-sm ${msg.ok ? 'bg-mint/10 text-mint' : 'bg-danger/10 text-danger'}`} role="alert">{msg.text}</p>}
        {!sent
          ? <button className={`${btnPrimary} w-full`} disabled={busy || !email.trim()} onClick={() => run(async () => { await sendLoginCode(email); setSent(true); setMsg({ ok: true, text: '이메일로 코드를 보냈어요. 메일함을 확인하세요.' }) })}>{busy ? '보내는 중…' : '코드 받기'}</button>
          : <>
              <button className={`${btnPrimary} w-full`} disabled={busy || !code.trim()} onClick={() => run(async () => { await verifyLoginCode(email, code, name); nav(next, { replace: true }) })}>{busy ? '확인 중…' : '로그인'}</button>
              <button className={`${btnGhost} w-full`} disabled={busy} onClick={() => { setSent(false); setCode(''); setMsg(null) }}>이메일 다시 입력</button>
            </>}
      </Card>
    </main>
  )
}
