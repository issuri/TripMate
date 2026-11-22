// 여행지 현지 시간대 기준의 날짜+시간 → 절대 시각(UTC ms). 알림은 항상 이 값으로 예약한다.
// 서머타임 전환일도 Intl 기준으로 계산한다. (존재하지 않는 시각은 전환 후 시각으로 보정)

function offsetMs(utcMs: number, timeZone: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value)
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'))
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/** date 'YYYY-MM-DD', time 'HH:mm', IANA timeZone → UTC ms */
export function zonedToUtc(date: string, time: string, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0)
  let guess = wall - offsetMs(wall, timeZone)
  guess = wall - offsetMs(guess, timeZone) // 전환 경계에서 한 번 더 보정
  return guess
}

export const isValidTimeZone = (tz: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false } }
