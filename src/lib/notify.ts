import { db } from '../db/local'
import { claimDue, reconcileTripSafe } from '../db/reminders'
import type { Reminder } from '../db/types'

export type PermissionState = 'unsupported' | 'default' | 'granted' | 'denied'

export const permissionState = (): PermissionState =>
  typeof Notification === 'undefined' ? 'unsupported' : (Notification.permission as PermissionState)

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
/** 홈 화면에 추가해서 앱처럼 실행 중인지(iOS 푸시/알림은 이 상태에서만 가능) */
export const isStandalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches

/** 알림 권한 요청은 반드시 사용자의 탭 같은 동작 안에서 호출해야 한다(iOS 요구사항). */
export async function requestPermission(): Promise<PermissionState> {
  if (permissionState() === 'unsupported') return 'unsupported'
  try { await Notification.requestPermission() } catch { /* 일부 브라우저는 콜백 방식 */ }
  return permissionState()
}

/** 시스템 알림 표시. tag=알림 id 라서 같은 알림이 중복 표시되지 않고 교체된다. */
export async function showReminder(r: Pick<Reminder, 'id' | 'title' | 'body' | 'url'>): Promise<boolean> {
  if (permissionState() !== 'granted') return false
  const opts: NotificationOptions = { body: r.body, tag: r.id, icon: `${import.meta.env.BASE_URL}icon.svg`, badge: `${import.meta.env.BASE_URL}icon.svg`, data: { url: r.url } }
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) { await reg.showNotification(r.title, opts); return true }
    new Notification(r.title, opts)
    return true
  } catch { return false }
}

type Listener = (fired: Reminder[], missed: Reminder[]) => void

/**
 * 앱이 열려 있는 동안(포그라운드/백그라운드 탭) 알림을 발송하는 루프.
 * 앱이 완전히 종료된 상태에서는 동작하지 않는다 → 서버 푸시가 필요(별도 구성).
 */
export function startReminderLoop(onDue: Listener, intervalMs = 20_000) {
  let stopped = false
  let running = false
  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      const { fire, missed } = await claimDue()
      for (const r of fire) await showReminder(r)
      if (fire.length || missed.length) onDue(fire, missed)
    } catch { /* DB 일시 오류 등: 다음 주기에 다시 시도 */ } finally { running = false }
  }
  // 시작 시: 모든 여행의 알림 예약을 일정 상태와 맞춘 뒤(과거 버전 데이터 포함) 바로 한 번 확인
  void db.trips.filter((t) => t.deletedAt === null).primaryKeys()
    .then((ids) => Promise.all(ids.map((id) => reconcileTripSafe(id))))
    .then(tick)
    .catch(() => undefined) // 시작 시 오류가 나도 주기적 확인은 계속된다
  const timer = setInterval(tick, intervalMs)
  const onVis = () => { if (document.visibilityState === 'visible') void tick() }
  document.addEventListener('visibilitychange', onVis)
  addEventListener('focus', onVis)
  return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); removeEventListener('focus', onVis) }
}
