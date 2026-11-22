// 경계값·무작위 테스트: 평소 눈에 안 띄는 입력에서 깨지는 곳을 찾는다.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { addItem, byOrder, listItems, moveItem } from '../db/itinerary'
import { TripMateDB } from '../db/local'
import { addPlace } from '../db/places'
import { createTrip, validateTrip } from '../db/trips'
import { addDays, daysBetween, isValidDate, tripDays } from './dates'
import { convertToHome, formatMinor, parseMajor, parseRateMicro, splitByWeights, splitEvenly } from './money'

describe('money parsing', () => {
  it('rejects ambiguous European-style decimals instead of silently multiplying by 100', () => {
    expect(parseMajor('1,50', 'USD')).toBeNull()      // "1,50"을 150.00으로 읽으면 안 된다
    expect(parseMajor('1,2,3', 'USD')).toBeNull()
    expect(parseMajor('12,34', 'JPY')).toBeNull()
  })
  it('accepts proper thousands separators and plain numbers', () => {
    expect(parseMajor('1,234', 'JPY')).toBe(1234)
    expect(parseMajor('1,234,567.89', 'USD')).toBe(123456789)
    expect(parseMajor(' 12 ', 'KRW')).toBe(12)
    expect(parseMajor('0.5', 'USD')).toBe(50)
    expect(parseMajor('.5', 'USD')).toBeNull()
    expect(parseMajor('1e3', 'USD')).toBeNull()
    expect(parseMajor('-5', 'USD')).toBeNull()
    expect(parseMajor('', 'USD')).toBeNull()
    expect(parseMajor('9'.repeat(30), 'USD')).toBeNull() // 안전 정수 범위 초과
  })
  it('rate parsing and conversion stay exact', () => {
    expect(parseRateMicro('0')).toBeNull()
    expect(parseRateMicro('1,380.5')).toBeNull()
    expect(parseRateMicro('1380.1234567')).toBeNull()
    expect(convertToHome(0, 'USD', 1380_000000)).toBe(0)
    expect(convertToHome(1, 'JPY', parseRateMicro('9.5')!)).toBe(10) // 9.5 → 반올림 10
  })
  it('formatMinor and parseMajor round-trip for many values', () => {
    for (const cur of ['KRW', 'JPY', 'USD', 'EUR']) {
      for (const n of [0, 1, 9, 10, 99, 100, 101, 12345, 99999999]) expect(parseMajor(formatMinor(n, cur), cur)).toBe(n)
    }
  })
})

describe('splitting', () => {
  it('always sums exactly to the total for random inputs', () => {
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 500; i++) {
      const total = Math.floor(rnd() * 1_000_000)
      const n = 1 + Math.floor(rnd() * 9)
      const w: number[] = Array.from({ length: n }, () => Math.floor(rnd() * 5))
      if (w.reduce((a, b) => a + b, 0) === 0) w[0] = 1
      const parts = splitByWeights(total, w)
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
      expect(parts.every((p, k) => p >= 0 && (w[k] > 0 || p === 0))).toBe(true)
      expect(splitEvenly(total, n).reduce((a, b) => a + b, 0)).toBe(total)
    }
  })
  it('rejects negative totals and bad weights', () => {
    expect(() => splitByWeights(-5, [1, 1])).toThrow()
    expect(() => splitByWeights(10, [])).toThrow()
    expect(() => splitByWeights(10, [0, 0])).toThrow()
    expect(() => splitByWeights(10, [1, -1])).toThrow()
    expect(() => splitByWeights(1.5, [1, 1])).toThrow()
  })
})

describe('dates', () => {
  it('rejects impossible calendar dates', () => {
    for (const d of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2025-02-29', '2026-1-5', '', 'abc', '2026-12-01T00:00']) expect(isValidDate(d)).toBe(false)
    for (const d of ['2026-02-28', '2028-02-29', '2026-12-31']) expect(isValidDate(d)).toBe(true)
  })
  it('handles month/year/leap boundaries', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(3)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(tripDays('2026-12-30', '2027-01-02')).toHaveLength(4)
  })
  it('validateTrip rejects impossible dates, absurd names and ranges', () => {
    const ok = { name: 'x', country: '', city: '', startDate: '2026-12-01', endDate: '2026-12-02' }
    expect(validateTrip(ok)).toBeNull()
    expect(validateTrip({ ...ok, startDate: '2026-02-30' })).not.toBeNull()
    expect(validateTrip({ ...ok, endDate: '2027-12-02' })).not.toBeNull()
    expect(validateTrip({ ...ok, name: 'a'.repeat(201) })).not.toBeNull()
  })
})

describe('data-layer input validation', () => {
  it('addPlace requires latitude and longitude together', async () => {
    const db = new TripMateDB('e-' + Math.random()); await db.open()
    const t = await createTrip({ name: 'T', country: '', city: '', startDate: '2026-12-01', endDate: '2026-12-02' }, db)
    await expect(addPlace(t.id, { name: 'half', lat: 35.1, lng: null }, db)).rejects.toThrow()
    await expect(addPlace(t.id, { name: 'nan', lat: NaN, lng: 1 }, db)).rejects.toThrow()
    await expect(addPlace(t.id, { name: 'inf', lat: Infinity, lng: 1 }, db)).rejects.toThrow()
    await expect(addPlace(t.id, { name: 'x'.repeat(300), lat: 1, lng: 1 }, db)).rejects.toThrow()
  })
})

describe('concurrent edits do not clobber each other', () => {
  it('a stale edit form only changes the fields the user actually touched', async () => {
    const { updateItem } = await import('../db/itinerary')
    const { addShopping, updateShopping } = await import('../db/shopping')
    const { changedFields } = await import('./diff')
    const db = new TripMateDB('c-' + Math.random()); await db.open()
    const t = await createTrip({ name: 'T', country: '', city: '', startDate: '2026-12-01', endDate: '2026-12-02' }, db)
    const it = await addItem(t.id, { dayNumber: 1, kind: 'sight', title: '원래 제목', memo: '원래 메모', startTime: '10:00' }, db)
    const opened = { ...it }                                         // 나: 편집 화면을 연 시점의 값
    await updateItem(it.id, { memo: '동행자가 고친 메모', startTime: '11:00' }, db) // 동행자: 같은 시간에 메모·시간 수정
    // 나: 제목만 바꾸고 저장(화면은 모든 필드를 오래된 값으로 들고 있음)
    const form = { title: '내가 고친 제목', kind: opened.kind, dayNumber: 1, startTime: opened.startTime, endTime: opened.endTime, memo: opened.memo, travelMinutes: null }
    await updateItem(it.id, changedFields(opened as unknown as Record<string, unknown>, form), db)
    const cur = (await db.itineraryItems.get(it.id))!
    expect(cur.title).toBe('내가 고친 제목')
    expect(cur.memo).toBe('동행자가 고친 메모')       // 덮어써지지 않음
    expect(cur.startTime).toBe('11:00')                 // 덮어써지지 않음

    const s = await addShopping(t.id, { name: '과자', quantity: 1, expectedPriceMinor: 500 }, db)
    await updateShopping(s.id, { expectedPriceMinor: 900 }, db)       // 동행자가 가격 수정
    await updateShopping(s.id, changedFields({ ...s } as unknown as Record<string, unknown>, { name: '새 이름', quantity: 1, expectedPriceMinor: 500 }), db)
    const sc = (await db.shoppingItems.get(s.id))!
    expect([sc.name, sc.expectedPriceMinor]).toEqual(['새 이름', 900])
  })
  it('unchanged saves are no-ops and record nothing in the sync queue', async () => {
    const { updateItem } = await import('../db/itinerary')
    const db = new TripMateDB('n-' + Math.random()); await db.open()
    const t = await createTrip({ name: 'T', country: '', city: '', startDate: '2026-12-01', endDate: '2026-12-02' }, db)
    const it = await addItem(t.id, { dayNumber: 1, kind: 'sight', title: ' 제목 ' }, db)
    await db.outbox.clear()
    await updateItem(it.id, { title: '제목', memo: '' }, db)
    expect(await db.outbox.count()).toBe(0)
    await updateItem(it.id, { memo: '메모' }, db)
    expect((await db.outbox.toArray())[0].changedFields).toEqual(['memo'])
  })
})

describe('length limits protect storage and layout', () => {
  it('rejects oversized text in items, checklist, shopping and trip edits', async () => {
    const db = new TripMateDB('l-' + Math.random()); await db.open()
    const { addChecklist, updateTrip } = await import('../db/itinerary')
    const { addShopping } = await import('../db/shopping')
    const t = await createTrip({ name: 'T', country: '', city: '', startDate: '2026-12-01', endDate: '2026-12-02' }, db)
    await expect(addItem(t.id, { dayNumber: 1, kind: 'sight', title: 'x'.repeat(201) }, db)).rejects.toThrow(/글자 수/)
    await expect(addItem(t.id, { dayNumber: 1, kind: 'sight', title: 'ok', memo: 'm'.repeat(2001) }, db)).rejects.toThrow(/글자 수/)
    await expect(addChecklist(t.id, 'c'.repeat(201), db)).rejects.toThrow(/글자 수/)
    await expect(addShopping(t.id, { name: 's'.repeat(201) }, db)).rejects.toThrow(/글자 수/)
    await expect(addShopping(t.id, { name: 'ok', quantity: 10000 }, db)).rejects.toThrow(/수량/)
    await expect(updateTrip(t.id, { coverImage: 'data:image/jpeg;base64,' + 'A'.repeat(1_600_000) }, db)).rejects.toThrow(/이미지/)
    expect(await listItems(t.id, db)).toHaveLength(0)
  })
})

describe('reordering stays consistent after many moves', () => {
  it('300 random moves never produce duplicate or unordered positions', async () => {
    const db = new TripMateDB('o-' + Math.random()); await db.open()
    const t = await createTrip({ name: 'T', country: '', city: '', startDate: '2026-12-01', endDate: '2026-12-02' }, db)
    const items = []
    for (let i = 0; i < 6; i++) items.push(await addItem(t.id, { dayNumber: 1, kind: 'sight', title: 'i' + i }, db))
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    // 같은 두 항목을 번갈아 옮기는 최악의 패턴 + 무작위 이동
    for (let k = 0; k < 150; k++) await moveItem(items[2].id, k % 2 ? 1 : -1, db)
    for (let k = 0; k < 150; k++) await moveItem(items[Math.floor(rnd() * 6)].id, rnd() < 0.5 ? -1 : 1, db)
    const list = (await listItems(t.id, db)).sort(byOrder)
    expect(new Set(list.map((i) => i.sortOrder)).size).toBe(6)      // 순서값이 겹치지 않는다
    expect(list.every((i) => Number.isFinite(i.sortOrder))).toBe(true)
    // 마지막 이동이 실제로 반영되는지: 맨 위 항목을 한 칸 아래로 → 두 번째가 된다
    const first = list[0]; await moveItem(first.id, 1, db)
    expect((await listItems(t.id, db)).sort(byOrder)[1].id).toBe(first.id)
  })
})
