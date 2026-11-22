import type { ChecklistItem, ItemKind, ItineraryItem } from '../db/types'

export interface GuideStage { key: string; label: string; total: number; pending: number; state: 'done' | 'current' | 'upcoming' | 'empty' }

interface Def { key: string; label: string; match: (i: ItineraryItem, lastDay: number) => boolean }
const isKind = (...k: ItemKind[]) => (i: ItineraryItem) => k.includes(i.kind)

// 여행의 시작부터 귀국까지 9단계. 단계 상태는 일정/체크리스트 완료 여부에서 계산한다.
const STAGES: Def[] = [
  { key: 'prep', label: '여행 준비', match: () => false }, // 체크리스트 기반
  { key: 'airport_out', label: '공항 이동', match: (i, l) => isKind('airport')(i) && !(l > 1 && i.dayNumber === l) },
  { key: 'flight_out', label: '항공편 탑승', match: (i, l) => isKind('flight')(i) && !(l > 1 && i.dayNumber === l) },
  { key: 'arrive', label: '목적지 도착·이동', match: (i) => isKind('transit')(i) && i.dayNumber === 1 },
  { key: 'checkin', label: '숙소 체크인', match: isKind('lodging_in') },
  { key: 'tour', label: '관광·식사·쇼핑', match: (i) => isKind('sight', 'meal', 'shopping', 'other', 'transit')(i) && i.dayNumber >= 1 && !(i.kind === 'transit' && i.dayNumber === 1) },
  { key: 'checkout', label: '숙소 체크아웃', match: isKind('lodging_out') },
  { key: 'airport_ret', label: '공항 이동(귀국)', match: (i, l) => isKind('airport')(i) && l > 1 && i.dayNumber === l },
  { key: 'return', label: '귀국', match: (i, l) => isKind('flight')(i) && l > 1 && i.dayNumber === l },
]

export function computeGuide(items: ItineraryItem[], checklist: ChecklistItem[], totalDays: number): GuideStage[] {
  const live = items.filter((i) => i.deletedAt === null)
  const list = checklist.filter((c) => c.deletedAt === null)
  const raw = STAGES.map((d) => {
    if (d.key === 'prep') {
      const pending = list.filter((c) => !c.done).length
      return { key: d.key, label: d.label, total: list.length, pending }
    }
    const m = live.filter((i) => d.match(i, totalDays))
    return { key: d.key, label: d.label, total: m.length, pending: m.filter((i) => !i.completed).length }
  })
  let currentSet = false
  return raw.map((s) => {
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
