import { addDays } from '../lib/dates'
import { zonedToUtc } from '../lib/tz'
import { eveReminderBody } from '../lib/tripType'
import { db as defaultDb, type TripMateDB } from './local'
import type { ItineraryItem, Reminder, Trip } from './types'

export const GRACE_MS = 15 * 60_000        // 이 시간 안에 늦은 알림은 앱을 열었을 때 바로 보여준다
export const KEEP_DONE_MS = 7 * 24 * 3600_000 // 발송/놓침 처리된 기록 보관 기간
export const LEAVE_BUFFER_MIN = 0           // "지금 출발" 알림은 도착 시각 - 이동시간
export const MIN_FUTURE_MS = 5_000

const KIND_NOUN: Record<string, string> = {
  airport: '공항 이동', flight: '항공편', transit: '이동', lodging_in: '숙소 체크인', lodging_out: '숙소 체크아웃',
  sight: '방문', meal: '식사', shopping: '쇼핑', other: '일정',
}

const route = (tripId: string, it: ItineraryItem) => `/trips/${tripId}/day/${it.dayNumber}?item=${it.id}`

/** 일정 하나에서 만들어져야 하는 알림들(순수 함수). 완료/비활성/시간 없음/삭제된 일정은 알림이 없다. */
export function desiredForItem(trip: Trip, it: ItineraryItem, now: number): Reminder[] {
  if (it.deletedAt !== null || it.completed || !it.reminderEnabled || !it.startTime) return []
  const date = addDays(trip.startDate, it.dayNumber - 1)
  const startUtc = zonedToUtc(date, it.startTime, trip.timeZone)
  const out: Reminder[] = []
  const base = { tripId: trip.id, itemId: it.id, url: route(trip.id, it), state: 'pending' as const, firedAt: null }
  const noun = KIND_NOUN[it.kind] ?? '일정'
  const startAt = startUtc - it.reminderMinutesBefore * 60_000
  if (startAt > now + MIN_FUTURE_MS) {
    out.push({
      ...base, id: `${it.id}:start`, kind: 'start', fireAt: startAt, title: it.title,
      body: it.reminderMinutesBefore > 0 ? `${it.reminderMinutesBefore}분 후 ${noun} (${it.startTime})` : `지금 ${noun} 시간이에요 (${it.startTime})`,
    })
  }
  // 다음 일정으로 이동해야 하는 시간
  if (it.travelMinutes && it.travelMinutes > 0) {
    const leaveAt = startUtc - (it.travelMinutes + LEAVE_BUFFER_MIN) * 60_000
    if (leaveAt > now + MIN_FUTURE_MS && leaveAt !== startAt) {
      out.push({ ...base, id: `${it.id}:leave`, kind: 'leave', fireAt: leaveAt, title: `${it.title}(으)로 출발`, body: `이동에 약 ${it.travelMinutes}분 걸려요. ${it.startTime} 도착 예정` })
    }
  }
  return out
}

/** 출발 전날 저녁 알림 */
export function desiredForTrip(trip: Trip, now: number): Reminder[] {
  if (trip.deletedAt !== null) return []
  const at = zonedToUtc(addDays(trip.startDate, -1), '20:00', trip.timeZone)
  if (at <= now + MIN_FUTURE_MS) return []
  return [{ id: `trip:${trip.id}:eve`, tripId: trip.id, itemId: null, kind: 'trip_eve', fireAt: at, title: `${trip.name} 출발 전날이에요`,
    body: eveReminderBody(trip), url: `/trips/${trip.id}/checklist`, state: 'pending', firedAt: null }]
}

/**
 * 여행의 알림을 일정 상태와 맞춘다(멱등). 일정 추가/수정/완료/삭제 후 항상 호출한다.
 *  - 새 알림 생성, 시각이 바뀌면 다시 예약(pending), 같은 시각이면 기존 상태(fired 등) 유지 → 중복 발송 없음
 *  - 더 이상 필요 없는 알림(삭제·완료·비활성)은 취소
 */
export async function reconcileTrip(tripId: string, db: TripMateDB = defaultDb, now = Date.now()) {
  await db.transaction('rw', [db.trips, db.itineraryItems, db.reminders], async () => {
    const trip = await db.trips.get(tripId)
    const existing = await db.reminders.where('tripId').equals(tripId).toArray()
    if (!trip || trip.deletedAt !== null) {
      if (existing.length) await db.reminders.bulkDelete(existing.map((r) => r.id))
      return
    }
    const items = await db.itineraryItems.where('tripId').equals(tripId).toArray()
    // "존재해야 하는 알림"은 시각과 무관하게 일정 상태만으로 정한다(-Infinity = 과거 시각도 포함).
    // 이미 도래했지만 아직 발송/놓침 처리되지 않은 알림을 재계산이 먼저 지워버리면, 오래 닫아 둔 앱을 열었을 때
    // "놓친 알림" 안내가 사라진다. 새 알림 생성만 아래에서 미래 시각으로 제한한다.
    const wanted = new Map<string, Reminder>()
    for (const r of [...desiredForTrip(trip, -Infinity), ...items.flatMap((i) => desiredForItem(trip, i, -Infinity))]) wanted.set(r.id, r)

    const have = new Map(existing.map((r) => [r.id, r]))
    const toPut: Reminder[] = []
    const drop: string[] = []
    for (const [id, w] of wanted) {
      const cur = have.get(id)
      if (!cur) { if (w.fireAt > now + MIN_FUTURE_MS) toPut.push(w) }              // 이미 지난 시각의 새 알림은 만들지 않는다
      else if (cur.fireAt !== w.fireAt) {                                           // 시각 변경 → 재예약
        if (w.fireAt > now + MIN_FUTURE_MS) toPut.push(w)
        else drop.push(id)                                                            // 새 시각이 이미 지났으면 예전 예약도 취소
      }
      else if (cur.title !== w.title || cur.body !== w.body || cur.url !== w.url) toPut.push({ ...cur, title: w.title, body: w.body, url: w.url })
    }
    const toCancel = existing.filter((r) => !wanted.has(r.id) && r.state === 'pending').map((r) => r.id)
    // 이미 지난(fired/missed) 기록: 대상 일정이 사라졌거나 7일이 지난 것은 정리
    const stale = existing.filter((r) => r.state !== 'pending' && (!wanted.has(r.id) || r.fireAt < now - KEEP_DONE_MS)).map((r) => r.id)
    if (toPut.length) await db.reminders.bulkPut(toPut)
    if (toCancel.length || stale.length || drop.length) await db.reminders.bulkDelete([...toCancel, ...stale, ...drop])
  })
}

/**
 * 데이터 변경 직후 호출하는 안전한 재계산. 알림 계산이 실패해도(예: 손상된 시간대 값) 이미 저장된 일정 변경은 유지하고
 * 오류를 호출자에게 던지지 않는다 — 던지면 화면은 "실패"로 보이는데 데이터는 저장돼 재시도 시 중복 생성될 수 있다.
 */
export async function reconcileTripSafe(tripId: string, db: TripMateDB = defaultDb) {
  try { await reconcileTrip(tripId, db) } catch (e) { console.error('알림 예약 갱신 실패', e instanceof Error ? e.message : 'unknown') }
}

export async function cancelTripReminders(tripId: string, db: TripMateDB = defaultDb) {
  await db.reminders.where('tripId').equals(tripId).delete()
}

/**
 * 도래한 알림을 처리한다. 상태 변경을 트랜잭션 안에서 먼저 확정하므로 여러 탭/반복 호출에도 한 번만 발송된다.
 * 너무 늦은 알림(GRACE_MS 초과)은 발송하지 않고 'missed'로 표시한다.
 */
export async function claimDue(db: TripMateDB = defaultDb, now = Date.now()): Promise<{ fire: Reminder[]; missed: Reminder[] }> {
  return db.transaction('rw', db.reminders, async () => {
    const due = await db.reminders.where('fireAt').belowOrEqual(now).filter((r) => r.state === 'pending').toArray()
    const fire: Reminder[] = [], missed: Reminder[] = []
    for (const r of due) {
      if (now - r.fireAt > GRACE_MS) { missed.push({ ...r, state: 'missed' }) } else fire.push({ ...r, state: 'fired', firedAt: now })
    }
    if (fire.length || missed.length) await db.reminders.bulkPut([...fire, ...missed])
    return { fire, missed }
  })
}

export const upcomingReminders = (tripId: string, db: TripMateDB = defaultDb) =>
  db.reminders.where('tripId').equals(tripId).filter((r) => r.state === 'pending').sortBy('fireAt')
