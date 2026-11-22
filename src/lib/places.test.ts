import { describe, expect, it } from 'vitest'
import { CURRENCIES, otherCurrencies, TIME_ZONES } from './locales'
import { CONTINENTS, findPlaces, PLACES, placeOf } from './places'
import { isValidTimeZone } from './tz'

describe('every place has what the form needs', () => {
  it('has a Korean country name, a valid time zone, and a currency that can actually be selected', () => {
    const selectable = new Set([...CURRENCIES, ...otherCurrencies()])
    expect(PLACES).toHaveLength(TIME_ZONES.length)
    for (const p of PLACES) {
      expect(/[가-힣]/.test(p.country), `${p.id} country`).toBe(true)
      expect(isValidTimeZone(p.id), p.id).toBe(true)
      expect(selectable.has(p.currency), `${p.id} → ${p.currency}`).toBe(true)
    }
  })
  it('has the right country and currency for well-known places', () => {
    expect(placeOf('Asia/Tokyo')).toMatchObject({ country: '일본', currency: 'JPY' })
    expect(placeOf('Europe/Paris')).toMatchObject({ country: '프랑스', currency: 'EUR' })
    expect(placeOf('Asia/Bangkok')).toMatchObject({ country: '태국', currency: 'THB' })
    expect(placeOf('America/Los_Angeles')).toMatchObject({ country: '미국', currency: 'USD' })
    expect(placeOf('Pacific/Guam')).toMatchObject({ country: '괌·사이판', currency: 'USD' })
    expect(placeOf('Asia/Kuwait')).toMatchObject({ currency: 'KWD' })
    expect(placeOf('Nowhere/Land')).toBeUndefined()
  })
  it('places in the same country share its name (so the trip header reads the same)', () => {
    const us = PLACES.filter((p) => p.country === '미국')
    expect(us.length).toBeGreaterThanOrEqual(7)
    expect(new Set(us.map((p) => p.currency))).toEqual(new Set(['USD']))
  })
})

describe('continents', () => {
  it('every place belongs to exactly one continent, in the order the list is shown', () => {
    for (const p of PLACES) expect(CONTINENTS, p.id).toContain(p.continent)
    // 목록은 대륙별로 이어져 있어야 한다(제목이 중간에 반복되지 않게)
    const seen: string[] = []
    for (const p of PLACES) if (seen.at(-1) !== p.continent) seen.push(p.continent)
    expect(seen).toEqual([...CONTINENTS])
  })
  it('puts well-known places on the right continent', () => {
    const c = (id: string) => placeOf(id)?.continent
    expect(c('Asia/Tokyo')).toBe('아시아')
    expect(c('Europe/Istanbul')).toBe('아시아')            // 튀르키예는 시간대 묶음상 아시아
    expect(c('Europe/Paris')).toBe('유럽')
    expect(c('Europe/Moscow')).toBe('유럽')
    expect(c('Africa/Cairo')).toBe('아프리카')
    expect(c('Indian/Mauritius')).toBe('아프리카')
    expect(c('America/New_York')).toBe('아메리카')
    expect(c('Pacific/Honolulu')).toBe('아메리카')
    expect(c('Australia/Sydney')).toBe('오세아니아')
    expect(c('Pacific/Guam')).toBe('오세아니아')
  })
  it('can search within one continent', () => {
    const eu = findPlaces('', [], '유럽')
    expect(eu.length).toBeGreaterThan(20)
    expect(eu.every((p) => p.continent === '유럽')).toBe(true)
    expect(findPlaces('일본', [], '유럽')).toEqual([])
    expect(findPlaces('일본', [], '아시아')[0].id).toBe('Asia/Tokyo')
    expect(findPlaces('', [], null)).toHaveLength(PLACES.length)
  })
})

describe('searching', () => {
  it('finds a country by name, and puts the best match first', () => {
    expect(findPlaces('일본')[0].id).toBe('Asia/Tokyo')
    expect(findPlaces('프랑스')[0].id).toBe('Europe/Paris')
  })
  it('finds a place by a city people actually type', () => {
    expect(findPlaces('도쿄')[0].id).toBe('Asia/Tokyo')
    expect(findPlaces('오사카')[0].id).toBe('Asia/Tokyo')
    expect(findPlaces('발리')[0].id).toBe('Asia/Makassar')
    expect(findPlaces('다낭')[0].id).toBe('Asia/Ho_Chi_Minh')
    expect(findPlaces('바르셀로나')[0].id).toBe('Europe/Madrid')
    expect(findPlaces('하와이')[0].id).toBe('Pacific/Honolulu')
    expect(findPlaces('사이판')[0].id).toBe('Pacific/Guam')
    expect(findPlaces('뉴욕')[0].id).toBe('America/New_York')
    expect(findPlaces('시드니')[0].id).toBe('Australia/Sydney')
  })
  it('works with the time zone id, mixed case, extra spaces and underscores', () => {
    expect(findPlaces('asia/tokyo')[0].id).toBe('Asia/Tokyo')
    expect(findPlaces('  TOKYO ')[0].id).toBe('Asia/Tokyo')
    expect(findPlaces('hong kong')[0].id).toBe('Asia/Hong_Kong')
  })
  it('a country with several time zones lists all of them', () => {
    expect(findPlaces('미국').map((p) => p.id)).toEqual(expect.arrayContaining(['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu']))
    expect(findPlaces('호주').length).toBeGreaterThanOrEqual(6)
  })
  it('an empty search shows everything; no match shows nothing; excluded places are hidden', () => {
    expect(findPlaces('')).toHaveLength(PLACES.length)
    expect(findPlaces('   ')).toHaveLength(PLACES.length)
    expect(findPlaces('zzzzqq')).toEqual([])
    expect(findPlaces('', ['Asia/Seoul']).some((p) => p.id === 'Asia/Seoul')).toBe(false)
    expect(findPlaces('한국', ['Asia/Seoul'])).toEqual([])
  })
  it('does not break on odd input', () => {
    for (const q of ['(', ')', '/', '\\', '[', '.*', '일본 일본', '%', '😀']) expect(() => findPlaces(q)).not.toThrow()
  })
})
