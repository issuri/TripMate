import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { listTrips } from '../db/trips'
import { computeStatus, daysBetween, todayIn } from '../lib/dates'

const STATUS = { planned: '예정', ongoing: '여행 중', finished: '종료' } as const
const STATUS_CLS = { planned: 'bg-signal-soft text-signal', ongoing: 'bg-coral text-white', finished: 'bg-line text-ink-2' } as const

export default function TripList() {
  const trips = useLiveQuery(() => listTrips(), [])
  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-[calc(1.5rem+env(safe-area-inset-top))]">
      <header className="mb-6 flex items-end justify-between px-1">
        <h1 className="text-[32px] font-extrabold leading-none tracking-tight">내 여행</h1>
        <Link to="/trips/new" className="rounded-full bg-ink px-5 py-3 text-sm font-semibold text-white active:scale-95">새 여행</Link>
      </header>
      {trips?.length === 0 && (
        <div className="rounded-[1.25rem] border-2 border-dashed border-line p-10 text-center">
          <p className="font-semibold">아직 여행이 없어요</p>
          <p className="mt-1 text-sm text-ink-2">날짜와 목적지를 정하면 일정표가 자동으로 만들어져요.</p>
        </div>
      )}
      <div className="space-y-4">
        {trips?.map((t) => {
          const st = computeStatus(t.startDate, t.endDate, t.timeZone)
          const d = st === 'planned' ? daysBetween(todayIn(t.timeZone), t.startDate) - 1 : null
          return (
            <Link key={t.id} to={`/trips/${t.id}`} className="block overflow-hidden rounded-[1.5rem] bg-white ring-1 ring-line active:scale-[.99]">
              {t.coverImage && <img src={t.coverImage} alt="" className="h-36 w-full object-cover" />}
              <div className="flex items-start justify-between gap-3 p-5">
                <div className="min-w-0">
                  <h2 className="truncate text-xl font-bold">{t.name}</h2>
                  <p className="mt-0.5 text-sm text-ink-2">{[t.country, t.city].filter(Boolean).join(', ') || '목적지 미정'}</p>
                  <p className="num mt-3 text-sm text-ink-2">{t.startDate.slice(5).replace('-', '.')} – {t.endDate.slice(5).replace('-', '.')} · {daysBetween(t.startDate, t.endDate)}일</p>
                </div>
                <div className="text-right">
                  <span className={`inline-block rounded-full px-3 py-1 text-xs font-bold ${STATUS_CLS[st]}`}>{STATUS[st]}</span>
                  {d !== null && <p className="num mt-2 text-2xl font-extrabold">D-{d}</p>}
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </main>
  )
}
