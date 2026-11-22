import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import { addItem, byOrder } from '../db/itinerary'
import { db } from '../db/local'
import { addPlace, deletePlace, validCoord } from '../db/places'
import type { Place, Trip } from '../db/types'
import { daysBetween } from '../lib/dates'
import { isDomestic } from '../lib/tripType'
import { directionsUrl, OSM_ATTRIBUTION, OSM_TILE_URL, placeUrl, searchPlaces, type Found, type Pt } from '../lib/maps'
import { askConfirm, btnGhost, btnPrimary, Card, Field, input, KIND_EMOJI } from './kit'

type Mode = 'walking' | 'transit' | 'driving'
const MODES: [Mode, string][] = [['transit', '대중교통'], ['walking', '도보'], ['driving', '차량']]
const toPt = (p: Place): Pt => ({ name: p.name, address: p.address, lat: p.lat, lng: p.lng })

function useOnline() {
  const [on, setOn] = useState(navigator.onLine)
  useEffect(() => {
    const u = () => setOn(navigator.onLine)
    window.addEventListener('online', u); window.addEventListener('offline', u)
    return () => { window.removeEventListener('online', u); window.removeEventListener('offline', u) }
  }, [])
  return on
}

export default function MapPage() {
  const trip = useOutletContext<Trip>()
  const total = daysBetween(trip.startDate, trip.endDate)
  const [sp, setSp] = useSearchParams()
  const day = Math.min(Math.max(Number(sp.get('day')) || 1, 1), total)
  const [mode, setMode] = useState<Mode>('transit')
  const online = useOnline()

  const items = (useLiveQuery(() => db.itineraryItems.where({ tripId: trip.id, dayNumber: day }).filter((i) => !i.deletedAt).toArray(), [trip.id, day]) ?? []).sort(byOrder)
  const places = useLiveQuery(() => db.places.where('tripId').equals(trip.id).filter((p) => !p.deletedAt).toArray(), [trip.id]) ?? []
  const byId = new Map(places.map((p) => [p.id, p]))  // 방문 순서 = 일정 순서. 일정 순서를 바꾸면 이 배열이 바뀌어 지도/경로가 함께 갱신된다.
  const stops = items.filter((i) => i.placeId && byId.has(i.placeId)).map((i) => ({ item: i, place: byId.get(i.placeId!)! }))

  return (
    <div className="space-y-4">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {Array.from({ length: total }, (_, i) => i + 1).map((d) => (
          <button key={d} onClick={() => setSp({ day: String(d) })} className={`num shrink-0 rounded-full px-4 py-2.5 text-sm font-bold ${d === day ? 'bg-ink text-white' : 'bg-white text-ink-2 ring-1 ring-line'}`}>DAY {d}</button>
        ))}
      </div>

      <MapView stops={stops.map((s) => s.place)} online={online} />

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold">DAY {day} 동선</h2>
          <div className="flex gap-1">
            {MODES.map(([m, l]) => <button key={m} onClick={() => setMode(m)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${mode === m ? 'bg-signal-soft text-signal' : 'text-ink-3'}`}>{l}</button>)}
          </div>
        </div>
        {stops.length === 0 && <p className="text-sm text-ink-2">장소가 연결된 일정이 없어요. 아래에서 장소를 저장하고 일정에 추가하세요.</p>}
        <ol className="space-y-1">
          {stops.map((s, i) => {
            const prev = stops[i - 1]
            const leg = prev ? directionsUrl([toPt(prev.place), toPt(s.place)], mode) : null
            return (
              <li key={s.item.id}>
                {leg && <a href={leg} target="_blank" rel="noreferrer" className="ml-3 block border-l-2 border-dashed border-line py-1.5 pl-6 text-xs font-semibold text-signal">
                  Google 지도 길찾기{s.item.travelMinutes != null && ` · 입력된 이동 ${s.item.travelMinutes}분`}</a>}
                <div className="flex items-center gap-3">
                  <span className="num grid h-7 w-7 shrink-0 place-content-center rounded-full bg-coral text-xs font-bold text-white">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{KIND_EMOJI[s.item.kind]} {s.place.name}</p>
                    <p className="num truncate text-xs text-ink-2">{s.item.startTime ?? '시간 미정'}{s.place.address && ` · ${s.place.address}`}</p>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
        {stops.length >= 2 && (
          <a href={directionsUrl(stops.map((s) => toPt(s.place)), mode)!} target="_blank" rel="noreferrer" className={`${btnPrimary} mt-4 block text-center`}>전체 경로를 Google 지도에서 열기</a>
        )}
        <p className="mt-3 text-xs text-ink-3">지도와 길찾기는 인터넷 연결이 필요해요. 장소 목록은 오프라인에서도 볼 수 있어요.</p>
      </Card>

      <PlaceSearch trip={trip} day={day} online={online} />

      <Card>
        <h2 className="mb-3 text-base font-bold">저장한 장소 {places.length}</h2>
        {places.length === 0 && <p className="text-sm text-ink-2">아직 저장한 장소가 없어요.</p>}
        <ul className="divide-y divide-line">
          {places.map((p) => (
            <li key={p.id} className="flex items-center gap-2 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{p.name}</p>
                <p className="num truncate text-xs text-ink-2">{p.address || '주소 없음'}{p.lat != null && ` · ${p.lat.toFixed(4)}, ${p.lng?.toFixed(4)}`}</p>
              </div>
              <a href={placeUrl(toPt(p))} target="_blank" rel="noreferrer" className="rounded-full px-3 py-2 text-xs font-semibold text-signal">지도</a>
              <button className="rounded-full bg-signal-soft px-3 py-2 text-xs font-semibold text-signal" onClick={() => addItem(trip.id, { dayNumber: day, kind: 'sight', title: p.name, placeId: p.id })}>DAY {day}에 추가</button>
              <button className="px-2 text-ink-3" aria-label="장소 삭제" onClick={async () => (await askConfirm(`"${p.name}" 장소를 삭제할까요?\n일정은 남고 장소 연결만 해제돼요.`, { confirmLabel: '삭제' })) && deletePlace(p.id)}>✕</button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

/** OpenStreetMap 지도. 타일은 브라우저가 필요할 때만 가져오며 앱이 미리 내려받거나 저장하지 않는다(약관). */
function MapView({ stops, online }: { stops: Place[]; online: boolean }) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const key = stops.map((s) => `${s.id}:${s.lat},${s.lng}`).join('|')
  const stopsRef = useRef(stops)
  // 지도 효과는 key가 바뀔 때만 다시 실행한다(매 렌더마다 줌/위치가 초기화되지 않도록). 최신 stops는 ref로 전달.
  useEffect(() => { stopsRef.current = stops })

  useEffect(() => {
    if (!online) { // 오프라인이 되면 지도 DOM이 사라지므로 인스턴스도 정리(다시 온라인이 되면 새로 만든다)
      mapRef.current?.remove(); mapRef.current = null; layer.current = null
      return
    }
    if (!el.current) return
    const stops = stopsRef.current
    if (!mapRef.current) {
      const map = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([37.5665, 126.978], 11)
      L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map)
      layer.current = L.layerGroup().addTo(map)
      mapRef.current = map
    }
    const g = layer.current!
    g.clearLayers()
    const pts = stops.filter((s) => s.lat != null && s.lng != null).map((s) => ({ s, ll: L.latLng(s.lat!, s.lng!) }))
    if (pts.length >= 2) L.polyline(pts.map((p) => p.ll), { color: '#d6336c', weight: 4, opacity: 0.85 }).addTo(g)
    pts.forEach(({ s, ll }, i) => {
      const icon = L.divIcon({ className: '', html: `<div style="width:28px;height:28px;border-radius:9999px;background:#ff6a3d;color:#fff;font:700 13px/28px system-ui;text-align:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)">${i + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] })
      L.marker(ll, { icon, title: s.name, alt: s.name }).addTo(g)
    })
    const map = mapRef.current
    map.invalidateSize()
    if (pts.length === 1) map.setView(pts[0].ll, 15)
    else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts.map((p) => p.ll)), { padding: [40, 40] })
  }, [key, online])

  useEffect(() => () => { mapRef.current?.remove(); mapRef.current = null }, [])

  if (!online) return (
    <div className="rounded-[1.5rem] border-2 border-dashed border-line p-6 text-center">
      <p className="font-semibold">오프라인이라 지도를 불러올 수 없어요</p>
      <p className="mt-1 text-sm text-ink-2">저장된 장소의 이름·주소·좌표와 방문 순서는 아래 목록에서 볼 수 있어요.</p>
    </div>
  )
  return <div ref={el} className="h-72 w-full overflow-hidden rounded-[1.5rem] bg-line" role="region" aria-label="여행 지도" />
}

function PlaceSearch({ trip, day, online }: { trip: Trip; day: number; online: boolean }) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<Found[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [manual, setManual] = useState({ name: '', address: '', lat: '', lng: '' })

  const search = async () => {
    if (busy) return
    setBusy(true); setMsg(null)
    try {
      const { results, cached } = await searchPlaces(`${q} ${trip.city}`.trim())
      setRes(results)
      setMsg(results.length ? (cached ? '이전 검색 결과예요.' : null) : (isDomestic(trip) ? '검색 결과가 없어요. 장소 이름이나 주소로 검색해 보세요.' : '검색 결과가 없어요. 현지어나 영어로 검색해 보세요.'))
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  const save = async (f: Pick<Found, 'name' | 'address' | 'lat' | 'lng'> & { id: string | null }, toDay: boolean) => {
    const p = await addPlace(trip.id, { name: f.name, address: f.address, lat: f.lat, lng: f.lng, externalId: f.id })
    if (toDay) await addItem(trip.id, { dayNumber: day, kind: 'sight', title: p.name, placeId: p.id })
    setMsg(`"${p.name}" ${toDay ? `저장 후 DAY ${day}에 추가했어요.` : '저장했어요.'}`)
  }
  const saveManual = async () => {
    const lat = manual.lat === '' ? null : Number(manual.lat), lng = manual.lng === '' ? null : Number(manual.lng)
    if ((lat !== null && Number.isNaN(lat)) || (lng !== null && Number.isNaN(lng)) || !validCoord(lat, lng) || (lat === null) !== (lng === null)) return setMsg('위도와 경도를 함께, 올바른 범위로 입력하세요.')
    try { await save({ id: null, name: manual.name, address: manual.address, lat: lat as number, lng: lng as number }, false); setManual({ name: '', address: '', lat: '', lng: '' }) } catch (e) { setMsg((e as Error).message) }
  }

  return (
    <Card className="space-y-3">
      <h2 className="text-base font-bold">장소 검색·저장</h2>
      {online ? (
        <>
          <div className="flex gap-2">
            <input className={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="장소 이름 검색" aria-label="장소 이름 검색" />
            <button className={`${btnPrimary} shrink-0`} disabled={busy} onClick={search}>{busy ? '검색 중' : '검색'}</button>
          </div>
          <p className="text-xs text-ink-3">검색어와 여행 도시 이름({trip.city || '없음'})이 OpenStreetMap 검색 서버로 전송돼요. 이름·전화번호·예약번호 같은 개인정보는 입력하지 마세요.</p>
          <ul className="divide-y divide-line">
            {res.map((f) => (
              <li key={f.id} className="flex items-center gap-2 py-3">
                <div className="min-w-0 flex-1"><p className="truncate font-semibold">{f.name}</p><p className="truncate text-xs text-ink-2">{f.address}</p></div>
                <button className="rounded-full bg-paper px-3 py-2 text-xs font-semibold" onClick={() => save(f, false)}>저장</button>
                <button className="rounded-full bg-signal-soft px-3 py-2 text-xs font-semibold text-signal" onClick={() => save(f, true)}>DAY {day}에 추가</button>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="rounded-2xl bg-paper p-3 text-sm text-ink-2">오프라인에서는 장소 검색을 쓸 수 없어요. 직접 입력은 가능해요.</p>}
      <details className="rounded-2xl bg-paper p-3" open={!online}>
        <summary className="cursor-pointer text-sm font-semibold">직접 입력</summary>
        <div className="mt-3 space-y-3">
          <Field label="장소 이름 *"><input className={input} value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} /></Field>
          <Field label="주소"><input className={input} value={manual.address} onChange={(e) => setManual({ ...manual, address: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="위도"><input inputMode="decimal" className={input} value={manual.lat} onChange={(e) => setManual({ ...manual, lat: e.target.value })} placeholder="35.7148" /></Field>
            <Field label="경도"><input inputMode="decimal" className={input} value={manual.lng} onChange={(e) => setManual({ ...manual, lng: e.target.value })} placeholder="139.7967" /></Field>
          </div>
          <button className={`${btnGhost} w-full`} onClick={saveManual}>장소 저장</button>
        </div>
      </details>
      {msg && <p className="text-sm text-ink-2" role="status">{msg}</p>}
    </Card>
  )
}
