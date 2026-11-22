import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { remindersEnabled, setRemindersEnabled, upcomingReminders } from '../db/reminders'
import type { Trip } from '../db/types'
import { isIOS, isStandalone, permissionState, requestPermission, showReminder, type PermissionState } from '../lib/notify'
import { isDomestic } from '../lib/tripType'
import { Card } from './kit'

const fmt = (ms: number, tz: string) =>
  new Intl.DateTimeFormat('ko-KR', { timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms)

/** 알림 권한 상태, 안내, 예약된 알림 요약. 권한 거부/미지원/iOS 설치 필요 상황을 각각 안내한다. */
export default function NotificationCard({ trip }: { trip: Trip }) {
  const [perm, setPerm] = useState<PermissionState>(permissionState())
  const [msg, setMsg] = useState<string | null>(null)
  const upcoming = useLiveQuery(() => upcomingReminders(trip.id), [trip.id]) ?? []
  const enabled = useLiveQuery(() => remindersEnabled(trip.id), [trip.id])   // undefined = 읽는 중(켜진 것으로 본다)
  const off = enabled === false

  useEffect(() => {
    const refresh = () => setPerm(permissionState())
    addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh)
    return () => { removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [])

  const needsInstall = isIOS() && !isStandalone()
  const enable = async () => {
    const p = await requestPermission()
    setPerm(p)
    if (p === 'granted') {
      const ok = await showReminder({ id: 'test', title: '알림이 켜졌어요', body: '일정 시간에 맞춰 알려드릴게요.', url: `/trips/${trip.id}` })
      setMsg(ok ? null : '알림 권한은 켜졌지만 테스트 알림을 표시하지 못했어요.')
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold">일정 알림</h2>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${!off && perm === 'granted' ? 'bg-mint/15 text-mint' : 'bg-line text-ink-2'}`}>
          {off ? '이 여행 꺼짐' : perm === 'granted' ? '켜짐' : perm === 'denied' ? '차단됨' : perm === 'unsupported' ? '미지원' : '꺼짐'}
        </span>
      </div>

      <label className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-paper px-4 py-3">
        <span>
          <span className="block text-sm font-semibold">이 여행 알림 받기</span>
          <span className="block text-xs text-ink-2">{off ? '꺼져 있어요. 예약된 알림이 없고 새로 예약하지 않아요.' : '끄면 이 기기에서 이 여행의 알림이 오지 않아요.'}</span>
        </span>
        <input type="checkbox" className="h-6 w-6 shrink-0 accent-signal" checked={!off} aria-label="이 여행 알림 받기"
          onChange={(e) => { void setRemindersEnabled(trip.id, e.target.checked) }} />
      </label>

      {off ? (
        <p className="mt-3 text-xs text-ink-3">알림은 기기마다 따로 설정해요. 다른 기기나 동행자의 알림에는 영향이 없어요. 일정마다 정한 알림 설정은 그대로 남아 있어서, 다시 켜면 그 설정대로 알려드려요.</p>
      ) : (<>
      {needsInstall && (
        <p className="mt-3 rounded-2xl bg-signal-soft p-3 text-sm text-signal">
          iPhone/iPad에서는 Safari 공유 버튼 → <b>홈 화면에 추가</b> 후 홈 화면의 앱을 열어야 알림을 받을 수 있어요.
        </p>
      )}
      {perm === 'unsupported' && <p className="mt-3 text-sm text-ink-2">이 브라우저는 알림을 지원하지 않아요. 앱 안의 알림 배너로만 알려드려요.</p>}
      {perm === 'default' && !needsInstall && (
        <button className="mt-3 w-full rounded-2xl bg-ink px-5 py-3.5 text-[15px] font-semibold text-white active:scale-[.97]" onClick={enable}>알림 켜기</button>
      )}
      {perm === 'denied' && (
        <p className="mt-3 rounded-2xl bg-danger/10 p-3 text-sm text-danger">
          알림이 차단되어 있어요. {isIOS() ? '설정 → 알림에서 이 앱의 알림을 허용' : '브라우저 주소창 옆 사이트 설정에서 알림을 허용'}한 뒤 다시 열어 주세요. 그동안은 앱을 열어 둔 때에만 앱 안 배너로 알려드려요.
        </p>
      )}
      {msg && <p className="mt-2 text-sm text-danger" role="alert">{msg}</p>}

      <div className="mt-3">
        {upcoming.length === 0
          ? <p className="text-sm text-ink-2">예약된 알림이 없어요. 시간이 있는 일정에는 알림이 자동으로 예약돼요.</p>
          : <>
              <p className="text-sm text-ink-2">예약된 알림 {upcoming.length}개 · {isDomestic(trip) ? '한국' : '현지'} 시간 기준</p>
              <ul className="mt-2 space-y-1.5">
                {upcoming.slice(0, 3).map((r) => (
                  <li key={r.id} className="num flex gap-3 text-sm"><span className="shrink-0 font-bold text-signal">{fmt(r.fireAt, trip.timeZone)}</span><span className="min-w-0 truncate">{r.title}</span></li>
                ))}
              </ul>
            </>}
      </div>
      <p className="mt-3 text-xs text-ink-3">앱을 닫은 상태에서는 서버 푸시 설정 전까지 시스템 알림이 오지 않아요. 앱을 열어 두거나 백그라운드에 두면 알려드려요.</p>
      </>)}
    </Card>
  )
}
