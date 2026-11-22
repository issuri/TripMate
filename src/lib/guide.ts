import type { ChecklistItem, ItemKind, ItineraryItem } from '../db/types'
import { addDays } from './dates'
import { zonedToUtc } from './tz'

export interface GuideStage {
  key: string; label: string; total: number; pending: number; state: 'done' | 'current' | 'upcoming' | 'empty'
  /** 완료 체크는 안 했지만 시각이 지나서 "지난 것"으로 본 일정 수 */
  passed: number
}

/** 시각을 알면(now·startDate·timeZone) 이미 지난 일정은 완료 체크가 없어도 지난 것으로 본다. 데이터는 바꾸지 않는다. */
export interface GuideOptions { domestic?: boolean; now?: number; startDate?: string; timeZone?: string }

type Role = 'out' | 'ret'
interface Ctx { lastDay: number; role: (i: ItineraryItem) => Role }
interface Def { key: string; label: string; match: (i: ItineraryItem, c: Ctx) => boolean }
const isKind = (...k: ItemKind[]) => (i: ItineraryItem) => k.includes(i.kind)

// 여행의 시작부터 귀국까지 9단계. 단계 상태는 일정/체크리스트 완료 여부(와 지난 시각)에서 계산한다.
const STAGES: Def[] = [
  { key: 'prep', label: '여행 준비', match: () => false }, // 체크리스트 기반
  { key: 'airport_out', label: '공항 이동', match: (i, c) => isKind('airport')(i) && c.role(i) === 'out' },
  { key: 'flight_out', label: '항공편 탑승', match: (i, c) => isKind('flight')(i) && c.role(i) === 'out' },
  { key: 'arrive', label: '목적지 도착·이동', match: (i) => isKind('transit')(i) && i.dayNumber === 1 },
  { key: 'checkin', label: '숙소 체크인', match: isKind('lodging_in') },
  { key: 'tour', label: '관광·식사·쇼핑', match: (i) => isKind('sight', 'meal', 'shopping', 'other', 'transit')(i) && i.dayNumber >= 1 && !(i.kind === 'transit' && i.dayNumber === 1) },
  { key: 'checkout', label: '숙소 체크아웃', match: isKind('lodging_out') },
  { key: 'airport_ret', label: '공항 이동(귀국)', match: (i, c) => isKind('airport')(i) && c.role(i) === 'ret' },
  { key: 'return', label: '귀국', match: (i, c) => isKind('flight')(i) && c.role(i) === 'ret' },
]

// 국내 여행: 공항·항공 단계는 해당 일정(예: 제주행 항공편)이 있을 때만 보이고, "귀국"은 "귀가"로 부른다.
const AIRPORT_KEYS = new Set(['airport_out', 'flight_out', 'airport_ret'])
const DOMESTIC_LABEL: Record<string, string> = { airport_ret: '공항 이동(귀가)', return: '귀가' }

const minuteOf = (t: string | null) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : 0)
/** 여행 시작부터 지난 분(정렬·간격 계산용). 시각이 없는 일정은 그날 0시로 본다. */
const orderKey = (i: ItineraryItem) => (i.dayNumber - 1) * 1440 + minuteOf(i.startTime)

/**
 * 항공편·공항 일정이 가는 길(out)인지 오는 길(ret)인지 정한다.
 *  - 항공편이 2개 이상: 시간 간격이 가장 큰 곳을 기준으로 앞은 가는 길, 뒤는 오는 길. 귀국편을 마지막 날이 아닌 날(심야 비행 등)에 넣어도 맞고,
 *    경유 비행도 한쪽으로 묶인다. 공항 일정은 마지막 "가는 길" 항공편보다 뒤에 있으면 오는 길이다.
 *  - 항공편이 0~1개: 마지막 날(2일 이상 여행)이면 오는 길, 아니면 가는 길.
 */
function airRoles(live: ItineraryItem[], lastDay: number): (i: ItineraryItem) => Role {
  const flights = live.filter((i) => i.kind === 'flight').sort((a, b) => orderKey(a) - orderKey(b))
  const byLastDay = (i: ItineraryItem): Role => (lastDay > 1 && i.dayNumber === lastDay ? 'ret' : 'out')
  if (flights.length < 2) return byLastDay
  let split = 0, gap = -1
  for (let k = 1; k < flights.length; k++) {
    const g = orderKey(flights[k]) - orderKey(flights[k - 1])
    if (g > gap) { gap = g; split = k }
  }
  const retIds = new Set(flights.slice(split).map((f) => f.id))
  const lastOutKey = orderKey(flights[split - 1])
  return (i) => (i.kind === 'flight' ? (retIds.has(i.id) ? 'ret' : 'out') : orderKey(i) > lastOutKey ? 'ret' : 'out')
}

export function computeGuide(items: ItineraryItem[], checklist: ChecklistItem[], totalDays: number, opts: GuideOptions = {}): GuideStage[] {
  const live = items.filter((i) => i.deletedAt === null)
  const list = checklist.filter((c) => c.deletedAt === null)
  const defs = opts.domestic ? STAGES.map((d) => ({ ...d, label: DOMESTIC_LABEL[d.key] ?? d.label })) : STAGES
  const ctx: Ctx = { lastDay: totalDays, role: airRoles(live, totalDays) }

  const timed = opts.now !== undefined && !!opts.startDate && !!opts.timeZone
  // 시각이 지난 일정: 시작 시각이 지났거나, 시각이 없으면 그날이 끝난 경우
  const isPast = (i: ItineraryItem) => {
    if (!timed) return false
    try { return zonedToUtc(addDays(opts.startDate!, i.dayNumber - 1), i.startTime ?? '23:59', opts.timeZone!) <= opts.now! } catch { return false }
  }
  // 출발한 뒤에는 준비 단계에 미완료 항목이 남아 있어도 끝난 것으로 본다(여행이 이미 시작됐으므로)
  const started = timed && (() => { try { return zonedToUtc(opts.startDate!, '00:00', opts.timeZone!) <= opts.now! } catch { return false } })()

  const raw = defs.map((d) => {
    if (d.key === 'prep') {
      const open = list.filter((c) => !c.done).length
      return { key: d.key, label: d.label, total: list.length, pending: started ? 0 : open, passed: started ? open : 0 }
    }
    const m = live.filter((i) => d.match(i, ctx))
    const open = m.filter((i) => !i.completed)
    const passed = open.filter(isPast).length
    return { key: d.key, label: d.label, total: m.length, pending: open.length - passed, passed }
  })
  let currentSet = false
  return raw.filter((s) => !(opts.domestic && AIRPORT_KEYS.has(s.key) && s.total === 0)).map((s) => {
    if (s.total === 0) return { ...s, state: 'empty' as const }
    if (s.pending === 0) return { ...s, state: 'done' as const }
    if (!currentSet) { currentSet = true; return { ...s, state: 'current' as const } }
    return { ...s, state: 'upcoming' as const }
  })
}

/** 아직 완료하지 않은 가장 이른 일정(날짜·순서 기준). 다음 행동 안내에 사용. */
export function nextItem(items: ItineraryItem[]): ItineraryItem | null {
  return items
    .filter((i) => i.deletedAt === null && !i.completed)
    .sort((a, b) => a.dayNumber - b.dayNumber || a.sortOrder - b.sortOrder)[0] ?? null
}

/** 일정 사이 이동/공백: 이전 일정 종료(또는 시작) 시각과 다음 시작 시각의 차이(분). */
export function gapMinutes(prev: ItineraryItem, next: ItineraryItem): number | null {
  const a = prev.endTime ?? prev.startTime
  if (!a || !next.startTime) return null
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  // 이전 일정이 자정을 넘겨 끝나면(종료 < 시작) 종료 시각에 24시간을 더한다
  const overnight = !!(prev.endTime && prev.startTime && prev.endTime < prev.startTime)
  const end = toMin(a) + (overnight ? 1440 : 0)
  // 이전 일정이 야간이고 다음 일정 시작이 이전 시작보다 이르면 다음 날 새벽으로 본다
  const start = toMin(next.startTime) + (overnight && prev.startTime && next.startTime < prev.startTime ? 1440 : 0)
  return start - end
}
