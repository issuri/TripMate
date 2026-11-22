import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ItemKind } from '../db/types'

export const KIND_LABEL: Record<ItemKind, string> = {
  airport: '공항', flight: '항공편', transit: '이동', lodging_in: '체크인', lodging_out: '체크아웃',
  sight: '관광', meal: '식사', shopping: '쇼핑', other: '기타',
}
export const KIND_EMOJI: Record<ItemKind, string> = {
  airport: '🛄', flight: '✈️', transit: '🚇', lodging_in: '🏨', lodging_out: '🧳', sight: '📍', meal: '🍜', shopping: '🛍️', other: '📝',
}

export const btn = 'rounded-2xl px-5 py-3.5 text-[15px] font-semibold transition active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100'
export const btnPrimary = `${btn} bg-ink text-white`
export const btnSignal = `${btn} bg-signal text-white`
export const btnGhost = `${btn} bg-white text-ink ring-1 ring-line`
export const input = 'w-full min-w-0 rounded-2xl border-0 bg-white px-4 py-3.5 text-base ring-1 ring-line placeholder:text-ink-3 focus:ring-2 focus:ring-signal outline-none'

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block min-w-0"><span className="mb-1.5 block px-1 text-[13px] font-medium text-ink-2">{label}</span>{children}</label>
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[1.25rem] bg-white p-4 ring-1 ring-line ${className}`}>{children}</section>
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="scrim fixed inset-0 z-50 flex items-end justify-center bg-ink/40 backdrop-blur-[2px] md:items-center" onClick={onClose} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div role="dialog" aria-label={title} className="sheet max-h-[92vh] max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-[1.75rem] bg-paper p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:rounded-[1.75rem]" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line md:hidden" />
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold">{title}</h2>
          <button className="grid h-9 w-9 place-content-center rounded-full bg-line/70 text-ink-2" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ───────── 앱 안의 확인창 ─────────
// 브라우저의 confirm() 은 일부 환경(앱 안 브라우저, 설치형 웹앱 등)에서 창을 띄우지 않고 바로 "취소"로 처리해서
// 삭제 버튼이 아무 반응도 하지 않는다. 그래서 앱이 직접 그리는 확인창을 쓴다. 사용: if (await askConfirm('…', { confirmLabel: '삭제' })) { … }
export interface ConfirmOptions { confirmLabel?: string; cancelLabel?: string; danger?: boolean }
interface Pending { message: string; opts: ConfirmOptions; resolve: (ok: boolean) => void }
let hostSet: ((p: Pending | null) => void) | null = null
let queue: Pending[] = []

export function askConfirm(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  if (!hostSet) return Promise.resolve(typeof confirm === 'function' ? confirm(message) : false)   // 확인창 자리가 없는 환경(테스트 등)
  return new Promise<boolean>((resolve) => {
    const p: Pending = { message, opts, resolve }
    if (queue.length === 0) hostSet!(p)        // 지금 떠 있는 창이 없으면 바로 보여준다
    queue.push(p)                               // 여러 개가 겹치면 차례대로 보여준다
  })
}

/** 앱 맨 위에 한 번만 둔다. */
export function ConfirmHost() {
  const [cur, setCur] = useState<Pending | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { hostSet = setCur; return () => { hostSet = null; queue.forEach((p) => p.resolve(false)); queue = [] } }, [])
  useEffect(() => { if (cur) cancelRef.current?.focus() }, [cur])    // 실수로 엔터를 눌러도 삭제되지 않게 "취소"에 포커스를 둔다
  if (!cur) return null
  const done = (ok: boolean) => {
    cur.resolve(ok)
    queue.shift()
    const next = queue[0] ?? null
    setCur(next)
  }
  const danger = cur.opts.danger !== false
  return (
    <div className="scrim fixed inset-0 z-[70] grid place-content-center bg-ink/50 p-6 backdrop-blur-[2px]" onClick={() => done(false)} onKeyDown={(e) => e.key === 'Escape' && done(false)}>
      <div role="alertdialog" aria-modal="true" aria-label="확인" className="sheet w-full max-w-sm rounded-[1.5rem] bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <p className="whitespace-pre-line text-[15px] leading-relaxed">{cur.message}</p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button ref={cancelRef} type="button" className={btnGhost} onClick={() => done(false)}>{cur.opts.cancelLabel ?? '취소'}</button>
          <button type="button" className={`${btn} ${danger ? 'bg-danger' : 'bg-ink'} text-white`} onClick={() => done(true)}>{cur.opts.confirmLabel ?? '확인'}</button>
        </div>
      </div>
    </div>
  )
}

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  route: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm12 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM9 6h5a4 4 0 0 1 0 8H10a4 4 0 0 0 0 8',
  check: 'M5 12.5 10 17.5 19 7',
  map: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  bag: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  wallet: 'M4 7a2 2 0 0 1 2-2h11v3M4 7v10a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6a2 2 0 0 1-2-2zM16 13.5h.01',
} as const
export function Icon({ name, className = 'h-6 w-6' }: { name: keyof typeof ICONS; className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={ICONS[name]} /></svg>
}
