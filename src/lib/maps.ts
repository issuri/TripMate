// 지도/검색: OpenStreetMap(타일) + Nominatim(장소 검색). API 키 없음.
// 약관 준수: ① 출처 표기 ② 검색은 사용자가 누를 때만, 초당 1회 이하 ③ 결과 캐시 ④ 타일 미리 내려받기/오프라인 저장 금지.
// 길찾기는 Google 지도 "링크"만 사용한다(키/비용 없음, 대중교통 경로는 Google이 계산).

export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'

export interface Pt { name: string; address?: string; lat: number | null; lng: number | null }

const enc = (p: Pt) => (p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : [p.name, p.address].filter(Boolean).join(' '))

export function directionsUrl(points: Pt[], mode: 'walking' | 'transit' | 'driving' = 'transit'): string | null {
  if (points.length < 2) return null
  const o = points[0], d = points[points.length - 1]
  const p = new URLSearchParams({ api: '1', origin: enc(o), destination: enc(d), travelmode: mode })
  const mid = points.slice(1, -1)
  if (mid.length) p.set('waypoints', mid.map(enc).join('|'))
  return `https://www.google.com/maps/dir/?${p.toString()}`
}

export const placeUrl = (p: Pt) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(enc(p))}`

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, r = (x: number) => (x * Math.PI) / 180
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// ───────── Nominatim 검색 ─────────
export interface Found { id: string; name: string; address: string; lat: number; lng: number }

interface NominatimRow { osm_type: string; osm_id: number; lat: string; lon: string; display_name: string; name?: string }

export interface SearchDeps {
  fetchFn?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

const MIN_GAP_MS = 1100        // 정책: 초당 1회 이하
const CACHE_KEY = 'tm.geocode.v1'
const CACHE_MAX = 60

export function createPlaceSearch(deps: SearchDeps = {}) {
  const fetchFn = deps.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const storage = deps.storage === undefined ? (typeof localStorage !== 'undefined' ? localStorage : null) : deps.storage
  let last = 0
  let chain: Promise<unknown> = Promise.resolve()

  const readCache = (): Record<string, { at: number; v: Found[] }> => {
    try { return JSON.parse(storage?.getItem(CACHE_KEY) ?? '{}') } catch { return {} }
  }
  const writeCache = (c: Record<string, { at: number; v: Found[] }>) => {
    const keys = Object.keys(c).sort((a, b) => c[b].at - c[a].at).slice(0, CACHE_MAX)
    const out: typeof c = {}
    keys.forEach((k) => (out[k] = c[k]))
    try { storage?.setItem(CACHE_KEY, JSON.stringify(out)) } catch { /* 저장 공간 부족 등은 무시 */ }
  }

  /** 같은 검색어는 캐시를 쓰고, 네트워크 요청은 한 줄로 세워 최소 1.1초 간격을 지킨다. */
  return function search(query: string): Promise<{ results: Found[]; cached: boolean }> {
    const q = query.trim().replace(/\s+/g, ' ')
    if (q.length < 2) return Promise.reject(new Error('검색어를 2글자 이상 입력하세요.'))
    const key = q.toLowerCase()
    const hit = readCache()[key]
    if (hit) return Promise.resolve({ results: hit.v, cached: true })

    const run = async () => {
      const wait = last + MIN_GAP_MS - now()
      if (wait > 0) await sleep(wait)
      last = now()
      const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '6', 'accept-language': 'ko' })}`
      let res: Response
      try { res = await fetchFn(url, { headers: { Accept: 'application/json' } }) } catch { throw new Error('인터넷에 연결할 수 없어요. 연결을 확인하고 다시 시도하세요.') }
      if (!res.ok) throw new Error(res.status === 429 ? '검색 요청이 너무 많아요. 잠시 후 다시 시도하세요.' : '검색에 실패했어요.')
      let rows: NominatimRow[]
      try { rows = (await res.json()) as NominatimRow[] } catch { throw new Error('검색 결과를 읽지 못했어요. 잠시 후 다시 시도하세요.') }
      if (!Array.isArray(rows)) throw new Error('검색 결과를 읽지 못했어요. 잠시 후 다시 시도하세요.')
      const results: Found[] = rows
        .map((r) => ({
          id: `${r.osm_type}/${r.osm_id}`,
          name: r.name || (r.display_name ?? '').split(',')[0],
          address: r.display_name ?? '',
          lat: Number(r.lat), lng: Number(r.lon),
        }))
        .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng) && Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180)
      const c = readCache(); c[key] = { at: now(), v: results }; writeCache(c)
      return { results, cached: false }
    }
    const p = chain.then(run, run)
    chain = p.catch(() => undefined)
    return p
  }
}

export const searchPlaces = createPlaceSearch()
