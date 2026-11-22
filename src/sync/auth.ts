// 로그인(Supabase Auth, 이메일 일회용 코드). 앱은 로그인 없이도 로컬 전용으로 쓸 수 있고, 공유·동기화에만 로그인이 필요하다.
// 매직 링크 대신 "이메일로 받은 숫자 코드 입력" 방식을 쓴다: iPhone 홈 화면 앱에서는 메일의 링크가 Safari로 열려 앱에 로그인이 되지 않기 때문이다.
import { useEffect, useState } from 'react'
import { createSharingApi } from './sharing'
import { setSignedInUser, supabase } from './runtime'

export type AuthStatus = 'unconfigured' | 'loading' | 'signed_out' | 'signed_in'
export interface AuthState { status: AuthStatus; userId: string | null; email: string | null }

let state: AuthState = { status: supabase ? 'loading' : 'unconfigured', userId: null, email: null }
const listeners = new Set<(s: AuthState) => void>()
const set = (s: AuthState) => { state = s; setSignedInUser(s.userId); listeners.forEach((l) => l(s)) }

let started = false
/** 앱 시작 시 한 번 호출: 저장된 세션을 복구하고 로그인/로그아웃 변화를 따라간다 */
export function startAuth() {
  if (started || !supabase) return
  started = true
  void supabase.auth.getSession().then(({ data }) => {
    const u = data.session?.user
    set(u ? { status: 'signed_in', userId: u.id, email: u.email ?? null } : { status: 'signed_out', userId: null, email: null })
  }).catch(() => set({ status: 'signed_out', userId: null, email: null }))
  supabase.auth.onAuthStateChange((_e, session) => {
    const u = session?.user
    set(u ? { status: 'signed_in', userId: u.id, email: u.email ?? null } : { status: 'signed_out', userId: null, email: null })
  })
}

export const getAuth = () => state
export function useAuth(): AuthState {
  const [s, setS] = useState(state)
  useEffect(() => { listeners.add(setS); setS(state); return () => { listeners.delete(setS) } }, [])
  return s
}

const need = () => { if (!supabase) throw new Error('서버(Supabase)가 설정되지 않았어요.'); return supabase }
const friendly = (m: string) =>
  /rate limit|too many/i.test(m) ? '요청이 너무 많아요. 잠시 후 다시 시도하세요.'
  : /invalid|expired|token/i.test(m) ? '코드가 올바르지 않거나 만료됐어요. 새 코드를 받아 다시 입력하세요.'
  : /network|fetch/i.test(m) ? '인터넷에 연결할 수 없어요.' : '로그인하지 못했어요. 잠시 후 다시 시도하세요.'

/** 이메일로 6자리 코드를 보낸다 */
export async function sendLoginCode(email: string) {
  const e = email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('이메일 주소를 확인하세요.')
  const { error } = await need().auth.signInWithOtp({ email: e, options: { shouldCreateUser: true } })
  if (error) throw new Error(friendly(error.message))
}

/** 이메일로 받은 코드로 로그인한다. 처음이면 표시 이름도 저장한다. */
export async function verifyLoginCode(email: string, code: string, displayName?: string) {
  const token = code.replace(/\s/g, '')
  if (!/^\d{6,8}$/.test(token)) throw new Error('이메일로 받은 숫자 코드를 입력하세요.')
  const sb = need()
  const { error } = await sb.auth.verifyOtp({ email: email.trim().toLowerCase(), token, type: 'email' })
  if (error) throw new Error(friendly(error.message))
  if (displayName?.trim()) {
    const rpc = async (fn: string, args: Record<string, unknown>) => { const { data, error: e } = await sb.rpc(fn, args); if (e) throw new Error(e.message); return data }
    await createSharingApi(rpc as never, async () => []).setDisplayName(displayName.trim()).catch(() => undefined) // 이름 저장 실패는 로그인 자체를 막지 않는다
  }
}

export async function signOut() { await supabase?.auth.signOut() }
