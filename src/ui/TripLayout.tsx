import { useLiveQuery } from 'dexie-react-hooks'
import { Link, NavLink, Outlet, useParams } from 'react-router-dom'
import { db } from '../db/local'
import { Icon } from './kit'

export default function TripLayout() {
  const { id = '' } = useParams()
  // 존재하지 않는 여행은 undefined(=로딩 중)와 구분되도록 null로 바꾼다
  const trip = useLiveQuery(async () => (await db.trips.get(id)) ?? null, [id])
  if (trip === undefined) return <p className="p-6 text-ink-2">불러오는 중…</p>
  if (!trip || trip.deletedAt) return <p className="p-6">여행을 찾을 수 없습니다. <Link className="text-signal underline" to="/">목록으로</Link></p>
  const tab = ({ isActive }: { isActive: boolean }) =>
    `flex flex-1 flex-col items-center gap-0.5 rounded-full py-2 text-[11px] font-semibold transition ${isActive ? 'bg-signal-soft text-signal' : 'text-ink-3'}`
  return (
    <div className="mx-auto min-h-screen max-w-2xl pb-32">
      <header className="flex items-center justify-between px-5 pb-1 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <Link to="/" className="grid h-10 w-10 place-content-center rounded-full bg-white text-xl text-ink-2 ring-1 ring-line" aria-label="여행 목록">‹</Link>
        <Link to={`/trips/${id}/edit`} className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink-2 ring-1 ring-line">수정</Link>
      </header>
      <h1 className="px-5 pb-3 pt-2 text-[28px] font-extrabold leading-tight tracking-tight">{trip.name}</h1>
      <div className="px-4"><Outlet context={trip} /></div>
      {/* 하단 플로팅 탭: 한 손 엄지 영역 */}
      <nav className="fixed inset-x-4 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-20 mx-auto flex max-w-md gap-1 rounded-full bg-white/85 p-1.5 shadow-[0_8px_30px_rgba(15,20,36,.12)] ring-1 ring-line backdrop-blur-xl">
        <NavLink end to={`/trips/${id}`} className={tab}><Icon name="home" className="h-5 w-5" />홈</NavLink>
        <NavLink to={`/trips/${id}/day/1`} className={tab}><Icon name="route" className="h-5 w-5" />일정</NavLink>
        <NavLink to={`/trips/${id}/map`} className={tab}><Icon name="map" className="h-5 w-5" />지도</NavLink>
        <NavLink to={`/trips/${id}/shopping`} className={tab}><Icon name="bag" className="h-5 w-5" />쇼핑</NavLink>
        <NavLink to={`/trips/${id}/checklist`} className={tab}><Icon name="check" className="h-5 w-5" />준비물</NavLink>
      </nav>
    </div>
  )
}
