import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Reminder } from '../db/types'
import { startReminderLoop } from '../lib/notify'

interface Toast { id: string; title: string; body: string; url: string | null }

/**
 * 앱이 열려 있는 동안 알림 루프를 돌리고, 시스템 알림 권한이 없어도 앱 안에서 배너로 알려준다.
 * 서비스워커가 보낸 "알림 클릭 → 이동" 메시지도 여기서 받아 해당 일정 화면으로 이동한다.
 */
export default function ReminderHost() {
  const nav = useNavigate()
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    const stop = startReminderLoop((fired: Reminder[], missed: Reminder[]) => {
      setToasts((cur) => {
        const next = [...cur]
        for (const r of fired) if (!next.some((t) => t.id === r.id)) next.push({ id: r.id, title: r.title, body: r.body, url: r.url })
        if (missed.length) next.push({ id: `missed:${Date.now()}`, title: `놓친 알림 ${missed.length}개`, body: missed.slice(0, 2).map((m) => m.title).join(', '), url: null })
        return next.slice(-3)
      })
    })
    return stop
  }, [])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'navigate' && typeof e.data.url === 'string' && e.data.url.startsWith('/')) nav(e.data.url) }
    navigator.serviceWorker?.addEventListener('message', onMsg)
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg)
  }, [nav])

  if (!toasts.length) return null
  return (
    <div className="fixed inset-x-3 top-[calc(0.5rem+env(safe-area-inset-top))] z-[60] mx-auto flex max-w-md flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="flex items-start gap-3 rounded-2xl bg-ink p-4 text-white shadow-[0_8px_30px_rgba(15,20,36,.3)]">
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold">🔔 {t.title}</p>
            <p className="mt-0.5 text-sm text-white/70">{t.body}</p>
            {t.url && <button className="mt-2 text-sm font-semibold text-coral" onClick={() => { nav(t.url!); setToasts((c) => c.filter((x) => x.id !== t.id)) }}>일정 보기</button>}
          </div>
          <button className="px-1 text-white/60" aria-label="알림 닫기" onClick={() => setToasts((c) => c.filter((x) => x.id !== t.id))}>✕</button>
        </div>
      ))}
    </div>
  )
}
