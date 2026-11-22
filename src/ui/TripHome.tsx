import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useOutletContext } from 'react-router-dom'
import { db } from '../db/local'
import type { Trip } from '../db/types'
import { addDays, computeStatus, daysBetween, todayIn } from '../lib/dates'
import { computeGuide, nextItem } from '../lib/guide'
import { Card, KIND_EMOJI, KIND_LABEL } from './kit'
import NotificationCard from './NotificationCard'
import OfflineSummary from './OfflineSummary'

export default function TripHome() {
  const trip = useOutletContext<Trip>()
  const items = useLiveQuery(() => db.itineraryItems.where('tripId').equals(trip.id).filter((i) => !i.deletedAt).toArray(), [trip.id]) ?? []
  const checklist = useLiveQuery(() => db.checklistItems.where('tripId').equals(trip.id).toArray(), [trip.id]) ?? []
  const activeMembers = (useLiveQuery(() => db.members.where('tripId').equals(trip.id).toArray(), [trip.id]) ?? []).filter((m) => m.status === 'active')
  const total = daysBetween(trip.startDate, trip.endDate)
  const status = computeStatus(trip.startDate, trip.endDate, trip.timeZone)
  const today = todayIn(trip.timeZone)
  const todayNo = status === 'ongoing' ? daysBetween(trip.startDate, today) : null
  const next = nextItem(items)
  const stages = computeGuide(items, checklist, total)
  const done = items.filter((i) => i.completed).length
  const dday = status === 'planned' ? daysBetween(today, trip.startDate) - 1 : null
  const currentIdx = stages.findIndex((s) => s.state === 'current')

  return (
    <div className="space-y-4">
      {trip.coverImage && <img src={trip.coverImage} alt="" className="h-44 w-full rounded-[1.5rem] object-cover" />}

      {/* 핵심 한 장: 다음 일정 티켓 */}
      <section className="ticket rounded-[1.5rem] bg-ink text-white" style={{ ['--cut' as string]: '68%' }}>
        <div className="p-5 pb-7">
          <div className="flex items-center justify-between text-sm text-white/60">
            <span>{[trip.country, trip.city].filter(Boolean).join(', ') || '여행'}</span>
            <span className="num">{status === 'planned' ? `D-${dday}` : status === 'ongoing' ? `DAY ${todayNo} / ${total}` : '종료'}</span>
          </div>
          {next ? (
            <Link to={`/trips/${trip.id}/day/${next.dayNumber}`} className="mt-5 block">
              <p className="text-sm font-semibold text-coral">다음 일정</p>
              <p className="num mt-1 text-5xl font-extrabold leading-none">{next.startTime ?? '--:--'}</p>
              <p className="mt-3 text-xl font-bold">{KIND_EMOJI[next.kind]} {next.title}</p>
              <p className="mt-1 text-sm text-white/60">DAY {next.dayNumber} · {addDays(trip.startDate, next.dayNumber - 1).slice(5).replace('-', '.')} · {KIND_LABEL[next.kind]}{next.locationText && ` · ${next.locationText}`}</p>
            </Link>
          ) : (
            <div className="mt-5">
              <p className="text-xl font-bold">{items.length ? '모든 일정을 마쳤어요' : '아직 일정이 없어요'}</p>
              <Link to={`/trips/${trip.id}/day/1`} className="mt-2 inline-block text-sm font-semibold text-coral">일정 추가하기</Link>
            </div>
          )}
        </div>
        <div className="mx-5 border-t border-dashed border-white/25" />
        <div className="num flex justify-between px-5 py-4 text-sm text-white/70">
          <span>{trip.startDate.slice(5).replace('-', '.')} – {trip.endDate.slice(5).replace('-', '.')}</span>
          <span>완료 {done}/{items.length}</span>
        </div>
      </section>

      {(activeMembers.length > 1 || trip.companions.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 px-1">
          {activeMembers.length > 1
            ? activeMembers.map((m) => <span key={m.id} className="rounded-full bg-white px-3 py-1.5 text-sm font-medium ring-1 ring-line">{m.displayName || '(이름 없음)'}{m.role === 'admin' ? ' · 관리자' : ''}</span>)
            : trip.companions.map((c) => <span key={c} className="rounded-full bg-white px-3 py-1.5 text-sm font-medium ring-1 ring-line">{c}</span>)}
          <Link to={`/trips/${trip.id}/share`} className="rounded-full px-2 py-1.5 text-sm font-semibold text-signal">공유 관리</Link>
          {trip.purpose && <span className="text-sm text-ink-2">{trip.purpose}</span>}
        </div>
      )}

      <OfflineSummary trip={trip} />

      <NotificationCard trip={trip} />

      <Card>
        <h2 className="mb-3 text-base font-bold">여행 가이드</h2>
        <ol className="relative">
          {stages.map((s, n) => (
            <li key={s.key} className="relative flex gap-3 pb-4 last:pb-0">
              {n < stages.length - 1 && <span className="absolute left-[11px] top-6 h-full w-0.5 bg-line" />}
              <span className={`relative z-10 grid h-6 w-6 shrink-0 place-content-center rounded-full text-[11px] font-bold ${
                s.state === 'done' ? 'bg-mint text-white' : s.state === 'current' ? 'bg-coral text-white ring-4 ring-coral/20' : 'bg-line text-ink-3'}`}>
                {s.state === 'done' ? '✓' : n + 1}
              </span>
              <div className="flex-1 pt-px">
                <p className={`text-[15px] ${s.state === 'current' ? 'font-bold' : s.state === 'empty' ? 'text-ink-3' : 'font-medium'}`}>{s.label}</p>
                {s.state === 'current' && <p className="text-sm text-coral">{s.pending}개 남음</p>}
                {s.state === 'empty' && <p className="text-xs text-ink-3">등록된 일정 없음</p>}
              </div>
            </li>
          ))}
        </ol>
        {currentIdx < 0 && items.length > 0 && <p className="mt-3 text-sm text-mint">모든 단계를 마쳤어요</p>}
      </Card>

      <Card>
        <h2 className="mb-3 text-base font-bold">날짜별 일정</h2>
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
            const c = items.filter((x) => x.dayNumber === n)
            const isToday = todayNo === n
            return (
              <Link key={n} to={`/trips/${trip.id}/day/${n}`} className={`rounded-2xl p-3 text-center ${isToday ? 'bg-coral text-white' : 'bg-paper'}`}>
                <div className="num text-sm font-bold">DAY {n}</div>
                <div className={`num text-xs ${isToday ? 'text-white/80' : 'text-ink-2'}`}>{c.filter((x) => x.completed).length}/{c.length}</div>
              </Link>
            )
          })}
        </div>
      </Card>
    </div>
  )
}
