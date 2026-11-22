// 날짜는 'YYYY-MM-DD' 문자열로만 다룬다(시간대 변환으로 하루가 밀리는 문제 방지).

const toUtc = (d: string) => {
  const [y, m, day] = d.split('-').map(Number)
  return Date.UTC(y, m - 1, day)
}

export const isValidDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(toUtc(d))

export function daysBetween(start: string, end: string): number {
  return Math.round((toUtc(end) - toUtc(start)) / 86400000) + 1
}

export function addDays(date: string, n: number): string {
  return new Date(toUtc(date) + n * 86400000).toISOString().slice(0, 10)
}

/** 여행 날짜 목록: DAY 1.. */
export function tripDays(start: string, end: string) {
  const n = daysBetween(start, end)
  return Array.from({ length: n }, (_, i) => ({ dayNumber: i + 1, date: addDays(start, i) }))
}

/** 현지 시간대 기준 오늘 날짜 */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export type TripStatus = 'planned' | 'ongoing' | 'finished'
export function computeStatus(start: string, end: string, timeZone: string, now = new Date()): TripStatus {
  const today = todayIn(timeZone, now)
  if (today < start) return 'planned'
  if (today > end) return 'finished'
  return 'ongoing'
}
