import { Fragment, useId, useMemo, useState } from 'react'
import { CONTINENTS, findPlaces, placeOf, type Continent, type Place } from '../lib/places'
import { input } from './kit'

/**
 * 여행지를 고른다. 대륙별로 나뉜 목록에서 고르거나, 나라·도시·별칭(예: 도쿄, 발리, 하와이)으로 검색할 수 있다.
 * 현지 통화 선택칸처럼 오른쪽 화살표가 있고, 누르면 목록이 열린다.
 */
export default function PlacePicker({ value, exclude = [], onPick }: { value: string; exclude?: string[]; onPick: (p: Place) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [cont, setCont] = useState<Continent | null>(null)      // null = 전체
  const listId = useId()
  const selected = placeOf(value)
  const shown = selected ? selected.label : value            // 목록에 없는 옛 값은 시간대 이름 그대로 보여준다
  const results = useMemo(() => (open ? findPlaces(q, exclude, cont) : []), [open, q, cont, exclude.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  // 검색어가 없고 "전체"일 때만 대륙 제목으로 나눠 보여준다(검색 중에는 가장 알맞은 순서가 우선이다)
  const grouped = !q.trim() && !cont

  const pick = (p: Place) => { onPick(p); setOpen(false); setQ(''); setCont(null) }
  const keep = (e: { preventDefault: () => void }) => e.preventDefault()   // 버튼을 눌러도 입력칸이 포커스를 잃어 목록이 닫히지 않게

  return (
    <div className="relative">
      <input
        role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" autoComplete="off" autoCapitalize="off" spellCheck={false}
        className={`${input} cursor-pointer pr-11`} value={open ? q : shown} placeholder={open ? '나라·도시 검색 (예: 일본, 발리)' : undefined}
        onFocus={() => { setQ(''); setOpen(true) }}
        onBlur={() => setOpen(false)}
        onChange={(e) => { setQ(e.target.value); setOpen(true) }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur() }
          if (e.key === 'Enter') { e.preventDefault(); if (results[0]) pick(results[0]) }
        }}
      />
      <svg viewBox="0 0 24 24" aria-hidden className={`pointer-events-none absolute right-4 top-[1.375rem] h-5 w-5 -translate-y-1/2 text-ink-2 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-2xl bg-white shadow-[0_8px_30px_rgba(15,20,36,.15)] ring-1 ring-line">
          {/* 대륙 필터 */}
          <div role="group" aria-label="대륙" className="flex gap-1.5 overflow-x-auto border-b border-line p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {([null, ...CONTINENTS] as (Continent | null)[]).map((c) => (
              <button key={c ?? 'all'} type="button" aria-pressed={cont === c} onMouseDown={keep} onTouchEnd={(e) => { keep(e); setCont(c) }} onClick={() => setCont(c)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${cont === c ? 'bg-ink text-white' : 'bg-paper text-ink-2'}`}>{c ?? '전체'}</button>
            ))}
          </div>
          <ul id={listId} role="listbox" className="max-h-60 overflow-y-auto p-1">
            {results.length === 0
              ? <li className="px-3 py-3 text-sm text-ink-2">찾는 곳이 없어요. 나라 이름이나 큰 도시 이름으로 다시 검색해 보세요.</li>
              : results.map((p, i) => (
                <Fragment key={p.id}>
                  {grouped && (i === 0 || results[i - 1].continent !== p.continent) && (
                    <li role="presentation" className="sticky top-0 bg-white px-3 pb-1 pt-2.5 text-xs font-semibold text-ink-3">{p.continent}</li>
                  )}
                  <li role="option" aria-selected={p.id === value}>
                    {/* 입력칸이 포커스를 잃어 목록이 닫히기 전에 선택되도록 mouseDown 에서 처리한다 */}
                    <button type="button" className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${p.id === value ? 'bg-signal-soft font-semibold' : 'hover:bg-paper'}`}
                      onMouseDown={(e) => { keep(e); pick(p) }} onTouchEnd={(e) => { keep(e); pick(p) }}>
                      <span>{p.label}</span>
                      <span className="shrink-0 text-xs text-ink-3">{p.currency}</span>
                    </button>
                  </li>
                </Fragment>
              ))}
          </ul>
        </div>
      )}
    </div>
  )
}
