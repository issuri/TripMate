import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import { addItem, byOrder, deleteItem, moveItem, setCompleted, updateItem, type ItemInput } from '../db/itinerary'
import { db } from '../db/local'
import type { ItemKind, ItineraryItem, Trip } from '../db/types'
import { addDays, daysBetween } from '../lib/dates'
import { gapMinutes } from '../lib/guide'
import { btnGhost, btnPrimary, Field, input, KIND_EMOJI, KIND_LABEL, Sheet } from './kit'

const MODE = { walk: '🚶 도보', transit: '🚇 대중교통', drive: '🚗 차량' } as const

export default function DayPage() {
  const trip = useOutletContext<Trip>()
  const { n } = useParams()
  const total = daysBetween(trip.startDate, trip.endDate)
  const day = Math.min(Math.max(Number(n) || 1, 1), total)
  const items = (useLiveQuery(() => db.itineraryItems.where({ tripId: trip.id, dayNumber: day }).filter((i) => !i.deletedAt).toArray(), [trip.id, day]) ?? []).sort(byOrder)
  const [editing, setEditing] = useState<ItineraryItem | 'new' | null>(null)
  const places = useLiveQuery(() => db.places.where('tripId').equals(trip.id).filter((p) => !p.deletedAt).toArray(), [trip.id]) ?? []
  const placeName = (it: ItineraryItem) => places.find((p) => p.id === it.placeId)?.name ?? it.locationText

  // 알림을 눌러 들어오면(?item=일정id) 해당 일정의 상세(편집) 시트를 바로 연다
  const [sp, setSp] = useSearchParams()
  const itemParam = sp.get('item')
  useEffect(() => {
    if (!itemParam) return
    const target = items.find((i) => i.id === itemParam)
    if (target) {
      setEditing(target)
      setSp((p) => { p.delete('item'); return p }, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemParam, items.length])

  return (
    <div className="space-y-4">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {Array.from({ length: total }, (_, i) => i + 1).map((d) => (
          <Link key={d} to={`/trips/${trip.id}/day/${d}`} className={`num shrink-0 rounded-full px-4 py-2.5 text-sm font-bold ${d === day ? 'bg-ink text-white' : 'bg-white text-ink-2 ring-1 ring-line'}`}>DAY {d}</Link>
        ))}
      </div>
      <p className="num px-1 text-sm text-ink-2">{addDays(trip.startDate, day - 1)} · 완료 {items.filter((i) => i.completed).length}/{items.length}</p>

      {items.length === 0 && (
        <div className="rounded-[1.25rem] border-2 border-dashed border-line p-8 text-center">
          <p className="font-semibold">이 날의 일정이 없어요</p>
          <p className="mt-1 text-sm text-ink-2">아래 버튼으로 첫 일정을 추가하세요.</p>
        </div>
      )}
      <ol className="relative">
        {items.map((it, idx) => {
          const prev = items[idx - 1]
          const gap = prev ? gapMinutes(prev, it) : null
          const short = gap != null && gap < (it.travelMinutes ?? 0)
          return (
            <li key={it.id} className="relative pl-9">
              {idx < items.length - 1 && <span className="absolute left-[13px] top-9 -bottom-1 w-0.5 bg-line" />}
              <span className={`absolute left-0 top-3.5 z-10 grid h-7 w-7 place-content-center rounded-full text-sm ${it.completed ? 'bg-mint text-white' : 'bg-white ring-2 ring-signal'}`}>{it.completed ? '✓' : ''}</span>
              {prev && (it.travelMinutes != null || gap != null) && (
                <p className={`num mb-2 -mt-1 rounded-full px-3 py-1 text-xs font-medium ${short ? 'bg-danger/10 text-danger' : 'bg-signal-soft text-signal'}`}>
                  {it.travelMinutes != null && <>이동 {it.travelMinutes}분{it.travelMode && ` · ${MODE[it.travelMode]}`}</>}
                  {gap != null && <>{it.travelMinutes != null && ' · '}간격 {gap}분{short && ' · 이동시간 부족'}</>}
                </p>
              )}
              <div className={`mb-3 flex items-start gap-3 rounded-[1.25rem] bg-white p-4 ring-1 ring-line ${it.completed ? 'opacity-55' : ''}`}>
                <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(it)}>
                  <p className="num text-sm font-bold text-signal">{it.startTime ?? '시간 미정'}{it.endTime && <span className="font-medium text-ink-3"> – {it.endTime}{it.startTime && it.endTime < it.startTime && ' (다음 날)'}</span>}</p>
                  <p className={`mt-0.5 text-[17px] font-bold leading-snug ${it.completed ? 'line-through' : ''}`}>{KIND_EMOJI[it.kind]} {it.title}</p>
                  {placeName(it) && <p className="mt-0.5 text-sm text-ink-2">{it.placeId ? '📍 ' : ''}{placeName(it)}</p>}
                  {it.memo && <p className="mt-1.5 text-sm text-ink-3">{it.memo}</p>}
                  {it.reminderEnabled && it.startTime && !it.completed && <p className="num mt-1.5 text-xs text-ink-3">🔔 {it.reminderMinutesBefore ? `${it.reminderMinutesBefore >= 60 ? `${it.reminderMinutesBefore / 60}시간` : `${it.reminderMinutesBefore}분`} 전` : '시작 시각'}</p>}
                </button>
                <div className="flex flex-col items-center gap-1">
                  <input type="checkbox" className="check" checked={it.completed} onChange={(e) => setCompleted(it.id, e.target.checked)} aria-label="완료" />
                  <button disabled={idx === 0} className="grid h-8 w-8 place-content-center rounded-full text-ink-3 disabled:opacity-20 active:bg-paper" onClick={() => moveItem(it.id, -1)} aria-label="위로">▲</button>
                  <button disabled={idx === items.length - 1} className="grid h-8 w-8 place-content-center rounded-full text-ink-3 disabled:opacity-20 active:bg-paper" onClick={() => moveItem(it.id, 1)} aria-label="아래로">▼</button>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <button className={`${btnPrimary} w-full`} onClick={() => setEditing('new')}>일정 추가</button>
      {editing && <ItemSheet trip={trip} total={total} day={day} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function ItemSheet({ trip, total, day, item, onClose }: { trip: Trip; total: number; day: number; item: ItineraryItem | null; onClose: () => void }) {
  const [f, setF] = useState({
    title: item?.title ?? '', kind: (item?.kind ?? 'sight') as ItemKind, dayNumber: item?.dayNumber ?? day,
    startTime: item?.startTime ?? '', endTime: item?.endTime ?? '', locationText: item?.locationText ?? '', memo: item?.memo ?? '',
    travelMinutes: item?.travelMinutes?.toString() ?? '', travelMode: item?.travelMode ?? '',
    reminderEnabled: item?.reminderEnabled ?? true, reminderMinutesBefore: item?.reminderMinutesBefore ?? 30,
    placeId: item?.placeId ?? '',
  })
  const saved = useLiveQuery(() => db.places.where('tripId').equals(trip.id).filter((p) => !p.deletedAt).toArray(), [trip.id]) ?? []
  const [err, setErr] = useState<string | null>(null)
  const busy = useRef(false)
  const s = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const save = async () => {
    const data: ItemInput = {
      title: f.title, kind: f.kind, dayNumber: f.dayNumber, startTime: f.startTime || null, endTime: f.endTime || null,
      placeId: f.placeId || null, locationText: f.locationText, memo: f.memo, travelMinutes: f.travelMinutes === '' ? null : Math.max(0, Math.round(Number(f.travelMinutes))),
      travelMode: (f.travelMode || null) as ItemInput['travelMode'], reminderEnabled: f.reminderEnabled, reminderMinutesBefore: f.reminderMinutesBefore,
    }
    if (busy.current) return // 연속 탭으로 일정이 중복 생성되는 것을 방지
    busy.current = true
    try { if (item) await updateItem(item.id, data); else await addItem(trip.id, data); onClose() } catch (e) { setErr((e as Error).message); busy.current = false }
  }
  return (
    <Sheet title={item ? '일정 수정' : '일정 추가'} onClose={onClose}>
      <div className="space-y-3">
        <Field label="제목 *"><input className={input} value={f.title} onChange={s('title')} autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="종류"><select className={input} value={f.kind} onChange={s('kind')}>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{KIND_EMOJI[k as ItemKind]} {l}</option>)}</select></Field>
          <Field label="날짜"><select className={input} value={f.dayNumber} onChange={(e) => setF({ ...f, dayNumber: Number(e.target.value) })}>
            {Array.from({ length: total }, (_, i) => i + 1).map((d) => <option key={d} value={d}>DAY {d}</option>)}</select></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="시작"><input type="time" className={input} value={f.startTime} onChange={s('startTime')} /></Field>
          <Field label="종료"><input type="time" className={input} value={f.endTime} onChange={s('endTime')} /></Field>
        </div>
        <Field label="저장한 장소 (지도 탭에서 저장)">
          <select className={input} value={f.placeId} onChange={s('placeId')}><option value="">연결 안 함</option>{saved.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </Field>
        <Field label="장소 메모 (직접 입력)"><input className={input} value={f.locationText} onChange={s('locationText')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="이전 일정에서 이동(분)"><input inputMode="numeric" className={input} value={f.travelMinutes} onChange={s('travelMinutes')} /></Field>
          <Field label="이동 수단"><select className={input} value={f.travelMode} onChange={s('travelMode')}><option value="">-</option>{Object.entries(MODE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        <Field label="메모"><textarea className={input} rows={3} value={f.memo} onChange={s('memo')} /></Field>
        <div className="rounded-2xl bg-white p-4 ring-1 ring-line">
          <label className="flex items-center justify-between gap-3">
            <span className="font-semibold">🔔 일정 알림</span>
            <input type="checkbox" className="h-6 w-6 accent-signal" checked={f.reminderEnabled} onChange={(e) => setF({ ...f, reminderEnabled: e.target.checked })} aria-label="일정 알림 사용" />
          </label>
          <div className="mt-3 flex items-center gap-2">
            <select className={input} disabled={!f.reminderEnabled} value={f.reminderMinutesBefore} aria-label="알림 시간" onChange={(e) => setF({ ...f, reminderMinutesBefore: Number(e.target.value) })}>
              {[[0, '시작 시각에'], [5, '5분 전'], [10, '10분 전'], [15, '15분 전'], [30, '30분 전'], [60, '1시간 전'], [120, '2시간 전'], [1440, '하루 전']].map(([m, l]) => <option key={m} value={m}>{l}</option>)}
            </select>
          </div>
          {f.reminderEnabled && !f.startTime && <p className="mt-2 text-xs text-ink-3">시작 시간을 입력하면 알림이 예약돼요.</p>}
          {f.reminderEnabled && f.travelMinutes !== '' && <p className="mt-2 text-xs text-ink-3">이동 시간이 입력되어 있어 출발할 시각에도 알려드려요.</p>}
        </div>
        {err && <p className="rounded-2xl bg-danger/10 p-3 text-sm text-danger" role="alert">{err}</p>}
        <div className="flex gap-2">
          {item && <button className={`${btnGhost} text-danger`} onClick={async () => { if (confirm('이 일정을 삭제할까요?')) { await deleteItem(item.id); onClose() } }}>삭제</button>}
          <button className={`${btnPrimary} flex-1`} onClick={save}>저장</button>
        </div>
      </div>
    </Sheet>
  )
}
