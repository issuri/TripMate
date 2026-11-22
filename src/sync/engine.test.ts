// 실제 PostgreSQL(PGlite)에 0001~0006 마이그레이션을 적용하고, 서로 다른 기기 2대(각자 로컬 DB)가 동기화하는 시나리오를 검증한다.
import 'fake-indexeddb/auto'
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { addChecklist, addItem, deleteItem, setCompleted, updateItem, updateTrip } from '../db/itinerary'
import { TripMateDB } from '../db/local'
import { addPlace } from '../db/places'
import { addShopping, setPurchased, updateShopping } from '../db/shopping'
import { createTrip, deleteTrip } from '../db/trips'
import { downloadTrip, pendingCount, removeOfflineCopy, resolveConflict, SyncNetworkError, SyncRejected, syncTrip, type PushRequest, type PushResult, type RemoteAdapter } from './engine'

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const C = '00000000-0000-0000-0000-00000000000c' // 여행 멤버가 아닌 사용자
let pg: PGlite

async function as(uid: string) {
  await pg.exec('reset role')
  await pg.exec(`select set_config('request.jwt.claim.sub', '${uid}', false)`)
  await pg.exec('set role authenticated')
}

/** 서버(PGlite)에 연결된 기기별 어댑터. down=true 이면 오프라인(네트워크 오류). */
function remoteFor(uid: string, client = 'device-' + uid.slice(-1)) {
  const state = { down: false, rejectNext: 0, pushes: [] as PushRequest[] }
  const adapter: RemoteAdapter = {
    userId: () => uid,
    clientId: () => client,
    async push(req) {
      if (state.down) throw new SyncNetworkError()
      if (state.rejectNext > 0) { state.rejectNext--; throw new SyncRejected('거부됨') }
      state.pushes.push(req)
      await as(uid)
      try {
        const r = await pg.query<{ r: PushResult }>('select public.sync_apply($1, $2::uuid, $3, $4, $5::jsonb, $6) as r', [req.table, req.id, req.op, req.baseVersion, JSON.stringify(req.fields), req.clientId])
        return r.rows[0].r
      } catch (e) { throw new SyncRejected((e as Error).message) }
    },
    async pull(table, tripId, since) {
      if (state.down) throw new SyncNetworkError()
      await as(uid)
      const col = table === 'trips' ? 'id' : 'trip_id'
      const r = await pg.query<{ j: Record<string, unknown> }>(`select to_jsonb(t) as j from public.${table} t where ${col} = $1::uuid and updated_at > to_timestamp($2 / 1000.0) order by updated_at, id`, [tripId, since])
      return r.rows.map((x) => x.j)
    },
  }
  return { adapter, state }
}

const newDb = async () => { const d = new TripMateDB('s-' + Math.random()); await d.open(); return d }

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role authenticated;`)
  const dir = join(process.cwd(), 'supabase', 'migrations')
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(join(dir, f), 'utf8'))
  await pg.exec(`grant usage on schema public, auth to authenticated; grant all on all tables in schema public to authenticated; grant execute on all functions in schema public, auth to authenticated;`)
  await pg.exec(`insert into auth.users values ('${A}'), ('${B}'), ('${C}')`)
})

let dbA: TripMateDB, dbB: TripMateDB
let ra: ReturnType<typeof remoteFor>, rb: ReturnType<typeof remoteFor>
let tripId: string
beforeEach(async () => {
  dbA = await newDb(); dbB = await newDb(); ra = remoteFor(A); rb = remoteFor(B)
  tripId = (await createTrip({ name: '도쿄', country: '일본', city: '도쿄', startDate: '2030-05-10', endDate: '2030-05-12', timeZone: 'Asia/Tokyo', localCurrency: 'JPY' }, dbA)).id
})

/** A가 만든 여행을 서버에 올리고, B를 멤버로 추가한 뒤 B 기기로 내려받는다 */
async function shareWithB() {
  expect((await syncTrip(tripId, ra.adapter, dbA)).error).toBeNull()
  await pg.exec('reset role')
  await pg.exec(`insert into trip_members (trip_id, user_id, role) values ('${tripId}', '${B}', 'member') on conflict do nothing`)
  const r = await downloadTrip(tripId, rb.adapter, dbB)
  expect(r.error).toBeNull()
}

describe('first upload and download', () => {
  it('uploads a locally created trip with its data and a second device downloads everything', async () => {
    const place = await addPlace(tripId, { name: '센소지', lat: 35.7148, lng: 139.7967 }, dbA)
    const item = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '관광', startTime: '14:00', placeId: place.id, travelMinutes: 20 }, dbA)
    await addChecklist(tripId, '보조배터리', dbA)
    await addShopping(tripId, { name: '과자', quantity: 2, expectedPriceMinor: 500, currency: 'JPY', storePlaceId: place.id }, dbA)
    await shareWithB()
    const t = (await dbB.trips.get(tripId))!
    expect([t.name, t.startDate, t.endDate, t.timeZone, t.localCurrency]).toEqual(['도쿄', '2030-05-10', '2030-05-12', 'Asia/Tokyo', 'JPY'])
    const i = (await dbB.itineraryItems.get(item.id))!
    expect([i.title, i.startTime, i.travelMinutes, i.placeId, i.dayNumber]).toEqual(['관광', '14:00', 20, place.id, 1])
    expect((await dbB.places.get(place.id))!.lat).toBeCloseTo(35.7148)
    expect(await dbB.checklistItems.where('tripId').equals(tripId).count()).toBe(6 + 1)
    expect((await dbB.shoppingItems.toArray())[0].storePlaceId).toBe(place.id)
    expect((await dbB.syncMeta.get(tripId))!.offlineSavedAt).not.toBeNull()
    // 내려받은 일정으로 알림도 예약된다
    expect(await dbB.reminders.get(`${item.id}:start`)).toBeDefined()
    // A 쪽도 서버가 준 값으로 동기화 상태가 정리됨
    expect((await dbA.trips.get(tripId))!.syncState).toBe('synced')
    expect(await pendingCount(tripId, dbA)).toBe(0)
  })

  it('re-sending the same data never creates duplicates (idempotent)', async () => {
    await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '점심', startTime: '12:00' }, dbA)
    await syncTrip(tripId, ra.adapter, dbA)
    // 응답을 못 받은 것처럼 큐를 되돌려 같은 변경을 다시 보낸다
    for (const it of await dbA.itineraryItems.toArray()) await dbA.outbox.add({ table: 'itinerary_items', recordId: it.id, op: 'upsert', baseVersion: 0, changedFields: ['*'], createdAt: Date.now() })
    await syncTrip(tripId, ra.adapter, dbA); await syncTrip(tripId, ra.adapter, dbA)
    await pg.exec('reset role')
    expect((await pg.query(`select 1 from itinerary_items where trip_id = '${tripId}'`)).rows).toHaveLength(1)
    expect(await dbA.conflicts.count()).toBe(0)
  })
})

describe('offline edits and merging', () => {
  it('different fields edited on two devices at the same time are both kept', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '관광', startTime: '10:00', memo: '' }, dbA)
    await shareWithB()
    rb.state.down = true                                                  // B는 오프라인
    await updateItem(it.id, { memo: 'B가 오프라인에서 쓴 메모' }, dbB)
    await updateItem(it.id, { startTime: '11:00' }, dbA)                  // A는 온라인에서 시간 변경
    await syncTrip(tripId, ra.adapter, dbA)
    rb.state.down = false
    const r = await syncTrip(tripId, rb.adapter, dbB)                     // B가 인터넷 복구 후 동기화
    expect(r.error).toBeNull(); expect(r.conflicts).toBe(0)
    await syncTrip(tripId, ra.adapter, dbA)
    for (const d of [dbA, dbB]) {
      const x = (await d.itineraryItems.get(it.id))!
      expect([x.startTime, x.memo]).toEqual(['11:00', 'B가 오프라인에서 쓴 메모'])
      expect(x.syncState).toBe('synced')
    }
  })

  it('the same field edited on two devices is kept as a conflict instead of being overwritten; resolving works both ways', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '원래', startTime: '10:00' }, dbA)
    await shareWithB()
    await updateItem(it.id, { title: 'A의 제목' }, dbA)
    await updateItem(it.id, { title: 'B의 제목' }, dbB)
    await syncTrip(tripId, ra.adapter, dbA)                               // A 먼저 서버에 반영
    const r = await syncTrip(tripId, rb.adapter, dbB)
    expect(r.conflicts).toBe(1)
    await pg.exec('reset role')
    expect((await pg.query<{ title: string }>(`select title from itinerary_items where id = '${it.id}'`)).rows[0].title).toBe('A의 제목') // 서버 값 유지
    const bRec = (await dbB.itineraryItems.get(it.id))!
    expect(bRec.title).toBe('B의 제목')                                    // B 화면의 값도 임의로 바꾸지 않음
    expect(bRec.syncState).toBe('conflict')
    const [c] = await dbB.conflicts.toArray()
    expect([c.field, c.localValue, c.remoteValue]).toEqual(['title', 'B의 제목', 'A의 제목'])
    // 충돌 중에 다시 동기화해도 로컬 값이 서버 값으로 덮이지 않는다
    await syncTrip(tripId, rb.adapter, dbB)
    expect((await dbB.itineraryItems.get(it.id))!.title).toBe('B의 제목')
    // 내 값으로 해결 → 서버에 반영
    await resolveConflict(c.id, 'mine', dbB)
    expect((await syncTrip(tripId, rb.adapter, dbB)).conflicts).toBe(0)
    await pg.exec('reset role')
    expect((await pg.query<{ title: string }>(`select title from itinerary_items where id = '${it.id}'`)).rows[0].title).toBe('B의 제목')
    await syncTrip(tripId, ra.adapter, dbA)
    expect((await dbA.itineraryItems.get(it.id))!.title).toBe('B의 제목')
    expect(await dbB.conflicts.count()).toBe(0)
  })

  it('"theirs" resolution adopts the server value', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '원래' }, dbA)
    await shareWithB()
    await updateItem(it.id, { title: 'A' }, dbA); await updateItem(it.id, { title: 'B' }, dbB)
    await syncTrip(tripId, ra.adapter, dbA); await syncTrip(tripId, rb.adapter, dbB)
    const [c] = await dbB.conflicts.toArray()
    await resolveConflict(c.id, 'theirs', dbB)
    expect((await dbB.itineraryItems.get(it.id))!.title).toBe('A')
    expect((await dbB.itineraryItems.get(it.id))!.syncState).toBe('synced')
    expect(await pendingCount(tripId, dbB)).toBe(0)
  })

  it('a checked shopping item is not reset by another device editing its name (no state reset)', async () => {
    const s = await addShopping(tripId, { name: '과자', expectedPriceMinor: 500 }, dbA)
    await shareWithB()
    rb.state.down = true
    await setPurchased(s.id, true, 480, dbB)                              // B: 오프라인에서 구매 완료 체크
    await updateShopping(s.id, { name: '새우깡' }, dbA); await syncTrip(tripId, ra.adapter, dbA) // A: 이름만 수정
    rb.state.down = false
    await syncTrip(tripId, rb.adapter, dbB); await syncTrip(tripId, ra.adapter, dbA)
    for (const d of [dbA, dbB]) {
      const x = (await d.shoppingItems.get(s.id))!
      expect([x.name, x.purchased, x.actualPriceMinor]).toEqual(['새우깡', true, 480])
    }
  })
})

describe('edits made while a sync is in flight', () => {
  it('editing the same field again during a push is not mistaken for a conflict with my own earlier push', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '처음' }, dbA)
    await shareWithB()
    await updateItem(it.id, { title: '첫 번째 수정' }, dbA)
    // 동기화가 진행되는 도중(서버 응답을 기다리는 사이)에 같은 필드를 다시 수정
    const slow: RemoteAdapter = { ...ra.adapter, push: async (req) => { const r = await ra.adapter.push(req); if (req.table === 'itinerary_items') await updateItem(it.id, { title: '두 번째 수정' }, dbA); return r } }
    const r1 = await syncTrip(tripId, slow, dbA)
    expect(r1.conflicts).toBe(0)
    const r2 = await syncTrip(tripId, ra.adapter, dbA)
    expect(r2.conflicts).toBe(0); expect(await dbA.conflicts.count()).toBe(0)
    await syncTrip(tripId, rb.adapter, dbB)
    expect((await dbB.itineraryItems.get(it.id))!.title).toBe('두 번째 수정')
    expect((await dbA.itineraryItems.get(it.id))!.syncState).toBe('synced')
  })
  it('the same user on a different device still gets a conflict for the same field', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '처음' }, dbA)
    await syncTrip(tripId, ra.adapter, dbA)
    const dbA2 = await newDb(); const ra2 = remoteFor(A, 'device-A-phone')
    await downloadTrip(tripId, ra2.adapter, dbA2)
    await updateItem(it.id, { title: '노트북' }, dbA); await updateItem(it.id, { title: '폰' }, dbA2)
    await syncTrip(tripId, ra.adapter, dbA)
    expect((await syncTrip(tripId, ra2.adapter, dbA2)).conflicts).toBe(1)
  })
})

describe('deletes', () => {
  it('a deleted item is never resurrected by a device that edited it offline', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '삭제될 일정' }, dbA)
    await shareWithB()
    rb.state.down = true
    await updateItem(it.id, { memo: 'B가 오프라인에서 수정' }, dbB)
    await deleteItem(it.id, dbA); await syncTrip(tripId, ra.adapter, dbA)
    rb.state.down = false
    const r = await syncTrip(tripId, rb.adapter, dbB)
    expect(r.conflicts).toBe(1)
    expect((await dbB.itineraryItems.get(it.id))!.deletedAt).not.toBeNull()
    expect((await dbB.conflicts.toArray())[0].kind).toBe('deleted')
    await pg.exec('reset role')
    expect((await pg.query<{ deleted_at: string | null }>(`select deleted_at from itinerary_items where id = '${it.id}'`)).rows[0].deleted_at).not.toBeNull()
    await syncTrip(tripId, ra.adapter, dbA)
    expect((await dbA.itineraryItems.get(it.id))!.deletedAt).not.toBeNull()
  })
  it('deleting offline is propagated; a never-synced item deleted offline is never sent', async () => {
    const synced = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '동기화된 일정' }, dbA)
    await shareWithB()
    const temp = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '잠깐 만든 일정' }, dbB)
    await deleteItem(temp.id, dbB); await deleteItem(synced.id, dbB)
    await syncTrip(tripId, rb.adapter, dbB)
    expect(rb.state.pushes.filter((p) => p.id === temp.id).every((p) => p.op === 'delete')).toBe(true) // 만들기는 보내지 않는다
    await pg.exec('reset role')
    expect((await pg.query(`select 1 from itinerary_items where id = '${temp.id}'`)).rows).toHaveLength(0)
    await syncTrip(tripId, ra.adapter, dbA)
    expect((await dbA.itineraryItems.get(synced.id))!.deletedAt).not.toBeNull()
    expect(await dbA.itineraryItems.get(temp.id)).toBeUndefined()
  })
  it('a trip created and deleted offline (never uploaded) leaves nothing on the server and nothing queued', async () => {
    await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '곧 사라질 일정' }, dbA)
    await deleteTrip(tripId, dbA)
    const r = await syncTrip(tripId, ra.adapter, dbA)
    expect(r.error).toBeNull()
    expect(ra.state.pushes.every((p) => p.op === 'delete')).toBe(true)     // 만들기는 보내지 않고, 삭제만 확인차 보낸다
    expect(await pendingCount(tripId, dbA)).toBe(0)
    await pg.exec('reset role')
    expect((await pg.query(`select 1 from trips where id = '${tripId}'`)).rows).toHaveLength(0)
  })
  it('deleting a whole trip (admin) syncs as a tombstone to other devices', async () => {
    await shareWithB()
    await deleteTrip(tripId, dbA); await syncTrip(tripId, ra.adapter, dbA)
    await syncTrip(tripId, rb.adapter, dbB)
    expect((await dbB.trips.get(tripId))!.deletedAt).not.toBeNull()
  })
  it('a non-admin member deleting the trip is rejected by the server, not silently accepted', async () => {
    await shareWithB()
    await deleteTrip(tripId, dbB)
    for (let i = 0; i < 5; i++) await syncTrip(tripId, rb.adapter, dbB)
    await pg.exec('reset role')
    expect((await pg.query<{ deleted_at: string | null }>(`select deleted_at from trips where id = '${tripId}'`)).rows[0].deleted_at).toBeNull()
    expect((await dbB.outbox.toArray()).find((e) => e.table === 'trips')!.attempts).toBe(5)
    // 사용자가 거부된 변경을 버리면 서버 상태로 돌아간다
    const { discardRejected } = await import('./engine')
    await dbB.trips.update(tripId, { deletedAt: null }) // (화면에서 삭제 표시를 되돌리는 경우를 흉내 — 서버 값이 최종 기준)
    const r = await discardRejected(tripId, rb.adapter, dbB)
    expect(r.error).toBeNull()
    expect(await pendingCount(tripId, dbB)).toBe(0)
    expect((await dbB.trips.get(tripId))!.deletedAt).toBeNull()
  })
})

describe('network failures and retries', () => {
  it('keeps the queue while offline, then syncs everything once the connection is back', async () => {
    await shareWithB()
    ra.state.down = true
    await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '오프라인 저녁', startTime: '19:00' }, dbA)
    const it = (await dbA.itineraryItems.toArray())[0]
    await setCompleted(it.id, true, dbA)
    const r = await syncTrip(tripId, ra.adapter, dbA)
    expect(r.error).toMatch(/네트워크/)
    expect(await pendingCount(tripId, dbA)).toBeGreaterThan(0)
    expect((await dbA.syncMeta.get(tripId))!.lastError).toMatch(/네트워크/)
    ra.state.down = false
    expect((await syncTrip(tripId, ra.adapter, dbA)).error).toBeNull()
    expect(await pendingCount(tripId, dbA)).toBe(0)
    await syncTrip(tripId, rb.adapter, dbB)
    const x = (await dbB.itineraryItems.get(it.id))!
    expect([x.title, x.completed]).toEqual(['오프라인 저녁', true])
  })
  it('simultaneous sync calls are serialized and send each change once', async () => {
    await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '점심' }, dbA)
    await Promise.all([syncTrip(tripId, ra.adapter, dbA), syncTrip(tripId, ra.adapter, dbA), syncTrip(tripId, ra.adapter, dbA)])
    const items = ra.state.pushes.filter((p) => p.table === 'itinerary_items')
    expect(items).toHaveLength(1)
  })
  it('a rejected change does not block others and stops retrying after the limit', async () => {
    await shareWithB()
    const good = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '정상' }, dbB)
    const bad = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '거부될 일정', placeId: '99999999-9999-9999-9999-999999999999' }, dbB) // 없는 장소 참조
    for (let i = 0; i < 6; i++) await syncTrip(tripId, rb.adapter, dbB)
    await pg.exec('reset role')
    const titles = (await pg.query<{ title: string }>(`select title from itinerary_items where trip_id = '${tripId}'`)).rows.map((x) => x.title)
    expect(titles).toContain('정상'); expect(titles).not.toContain('거부될 일정')
    const stuck = await dbB.outbox.where('recordId').equals(bad.id).toArray()
    expect(stuck[0].attempts).toBe(5)
    expect(good.id).toBeDefined()
    const r = await syncTrip(tripId, rb.adapter, dbB)
    expect(r.stuck).toBe(1)
  })
})

describe('failure scenarios', () => {
  it('a server that never answers does not freeze sync forever (timeout, then recovers)', async () => {
    await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '멈춤 테스트' }, dbA)
    const hung: RemoteAdapter = { ...ra.adapter, push: () => new Promise<PushResult>(() => {}), pull: () => new Promise(() => {}) }
    const t0 = Date.now()
    const r = await syncTrip(tripId, hung, dbA, { timeoutMs: 80 })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.error).toMatch(/네트워크|시간/)
    expect(await pendingCount(tripId, dbA)).toBeGreaterThan(0)            // 변경은 유실되지 않는다
    expect((await syncTrip(tripId, ra.adapter, dbA)).error).toBeNull()     // 서버가 돌아오면 바로 정상 동작
    expect(await pendingCount(tripId, dbA)).toBe(0)
  })

  it('when the server applied a change but the response was lost, the retry causes no duplicate and no false conflict', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '처음' }, dbA)
    await shareWithB()
    await updateItem(it.id, { title: '응답 유실 테스트', memo: '메모' }, dbA)
    let first = true
    const lossy: RemoteAdapter = { ...ra.adapter, push: async (req) => { const r = await ra.adapter.push(req); if (first && req.table === 'itinerary_items') { first = false; throw new SyncNetworkError() } return r } }
    expect((await syncTrip(tripId, lossy, dbA)).error).toMatch(/네트워크/)  // 서버에는 반영됐지만 응답을 못 받음
    const r = await syncTrip(tripId, ra.adapter, dbA)                      // 같은 변경을 다시 보냄
    expect(r.error).toBeNull(); expect(r.conflicts).toBe(0)
    expect(await dbA.conflicts.count()).toBe(0)
    await pg.exec('reset role')
    expect((await pg.query(`select 1 from itinerary_items where trip_id = '${tripId}'`)).rows).toHaveLength(1)
    await syncTrip(tripId, rb.adapter, dbB)
    expect((await dbB.itineraryItems.get(it.id))!.title).toBe('응답 유실 테스트')
  })

  it('a record created offline whose first upload response was lost is not duplicated or conflicted', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'meal', title: '새 일정', startTime: '12:00', memo: '메모' }, dbA)
    let first = true
    const lossy: RemoteAdapter = { ...ra.adapter, push: async (req) => { const r = await ra.adapter.push(req); if (first && req.table === 'itinerary_items') { first = false; throw new SyncNetworkError() } return r } }
    await syncTrip(tripId, lossy, dbA)
    const r = await syncTrip(tripId, ra.adapter, dbA)
    expect(r.conflicts).toBe(0)
    await pg.exec('reset role')
    expect((await pg.query(`select 1 from itinerary_items where id = '${it.id}'`)).rows).toHaveLength(1)
  })

  it('delete before the retry of a lost-response upload still deletes the row the server already created', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '곧 삭제' }, dbA)
    await syncTrip(tripId, ra.adapter, dbA)                                // 여행은 서버에 있음
    const again = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '응답 유실 후 삭제' }, dbA)
    let lose = true
    const lossy: RemoteAdapter = { ...ra.adapter, push: async (req) => { const r = await ra.adapter.push(req); if (lose && req.id === again.id) { lose = false; throw new SyncNetworkError() } return r } }
    await syncTrip(tripId, lossy, dbA)                                     // 서버엔 생겼지만 응답 유실 → 큐 유지, 로컬 version 0
    await deleteItem(again.id, dbA)                                        // 재시도 전에 삭제
    await syncTrip(tripId, ra.adapter, dbA)
    await pg.exec('reset role')
    expect((await pg.query<{ deleted_at: string | null }>(`select deleted_at from itinerary_items where id = '${again.id}'`)).rows[0].deleted_at).not.toBeNull()
    expect(it.id).toBeDefined()
  })

  it('deleting a place after an item linked to it was deleted offline never resurrects that item on the server', async () => {
    await syncTrip(tripId, ra.adapter, dbA)
    const place = await addPlace(tripId, { name: '장소', lat: 35.1, lng: 139.1 }, dbA)
    const gone = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '곧 지울 일정', placeId: place.id }, dbA)
    await deleteItem(gone.id, dbA)                                         // 한 번도 올리지 않고 삭제
    const { deletePlace } = await import('../db/places')
    await deletePlace(place.id, dbA)                                       // 삭제된 일정은 건드리지 않아야 한다
    expect((await dbA.outbox.toArray()).some((e) => e.recordId === gone.id && e.changedFields.includes('placeId'))).toBe(false)
    await syncTrip(tripId, ra.adapter, dbA)
    await pg.exec('reset role')
    expect((await pg.query<{ deleted_at: string | null }>(`select deleted_at from itinerary_items where id = '${gone.id}'`)).rows.every((r) => r.deleted_at !== null)).toBe(true)
  })

  it('engine safety net: even a stray edit entry on a locally deleted record is sent as a delete, never as an upload', async () => {
    await syncTrip(tripId, ra.adapter, dbA)
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '삭제될 일정' }, dbA)
    await deleteItem(it.id, dbA)
    await dbA.outbox.add({ table: 'itinerary_items', recordId: it.id, op: 'upsert', baseVersion: 0, changedFields: ['*'], createdAt: Date.now() }) // 삭제 후에 생긴 잘못된 수정 기록
    await syncTrip(tripId, ra.adapter, dbA)
    expect(ra.state.pushes.filter((p) => p.id === it.id).every((p) => p.op === 'delete')).toBe(true)
    await pg.exec('reset role')
    expect((await pg.query(`select 1 from itinerary_items where id = '${it.id}' and deleted_at is null`)).rows).toHaveLength(0)
  })

  it('three devices editing different things all converge; trips do not leak into each other', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '공유 일정', startTime: '10:00' }, dbA)
    await shareWithB()
    const dbA2 = await newDb(); const ra2 = remoteFor(A, 'devA-phone'); await downloadTrip(tripId, ra2.adapter, dbA2)
    const other = (await createTrip({ name: '다른 여행', country: '', city: '', startDate: '2030-06-01', endDate: '2030-06-02' }, dbA)).id
    const otherItem = await addItem(other, { dayNumber: 1, kind: 'sight', title: '다른 여행 일정' }, dbA)
    await syncTrip(other, ra.adapter, dbA)
    await updateItem(it.id, { memo: 'A의 메모' }, dbA); await updateItem(it.id, { startTime: '11:00' }, dbB); await updateItem(it.id, { dayNumber: 2 }, dbA2)
    for (let i = 0; i < 3; i++) for (const [d, r] of [[dbA, ra], [dbB, rb], [dbA2, ra2]] as const) await syncTrip(tripId, r.adapter, d)
    for (const d of [dbA, dbB, dbA2]) { const x = (await d.itineraryItems.get(it.id))!; expect([x.memo, x.startTime, x.dayNumber]).toEqual(['A의 메모', '11:00', 2]) }
    expect(await dbB.itineraryItems.get(otherItem.id)).toBeUndefined()     // 동기화하지 않은 다른 여행은 B에게 보이지 않는다
    expect(await dbB.trips.get(other)).toBeUndefined()
  })

  it('legacy records with missing fields upload without violating server constraints', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '옛 레코드' }, dbA)
    // 필드가 없던 시절의 레코드를 흉내(알림 필드, 장소 메모 없음)
    const legacy = { ...(await dbA.itineraryItems.get(it.id))! } as Record<string, unknown>
    delete legacy.reminderEnabled; delete legacy.reminderMinutesBefore; delete legacy.locationText; delete legacy.memo
    await dbA.itineraryItems.put(legacy as never)
    const r = await syncTrip(tripId, ra.adapter, dbA)
    expect(r.error).toBeNull()
    await pg.exec('reset role')
    const row = (await pg.query<{ reminder_enabled: boolean; reminder_minutes_before: number; memo: string }>(`select reminder_enabled, reminder_minutes_before, memo from itinerary_items where id = '${it.id}'`)).rows[0]
    expect([row.reminder_enabled, row.reminder_minutes_before, row.memo]).toEqual([true, 30, ''])   // 서버 기본값
  })

  it('special characters, emoji, long text, arrays and decimals round-trip exactly', async () => {
    const weird = `따옴표 ' " \\ 백슬래시; DROP TABLE trips; -- 😀 한글 <b>태그</b>\n줄바꿈`
    await updateTrip(tripId, { name: weird, companions: ['민수', "O'Brien", '지은 😀'], purpose: 'x'.repeat(500) }, dbA)
    const p = await addPlace(tripId, { name: weird, address: '주소', lat: 35.714812345678, lng: -139.79670000001 }, dbA)
    await addItem(tripId, { dayNumber: 1, kind: 'sight', title: weird, memo: 'm'.repeat(2000), startTime: '09:05', endTime: '23:59', travelMinutes: 0, placeId: p.id }, dbA)
    await shareWithB()
    const t = (await dbB.trips.get(tripId))!
    expect([t.name, t.companions, t.purpose.length]).toEqual([weird, ['민수', "O'Brien", '지은 😀'], 500])
    const bp = (await dbB.places.get(p.id))!
    expect([bp.lat, bp.lng, bp.name]).toEqual([35.714812345678, -139.79670000001, weird])
    const bi = (await dbB.itineraryItems.toArray()).find((i) => i.placeId === p.id)!
    expect([bi.title, bi.memo.length, bi.startTime, bi.endTime, bi.travelMinutes]).toEqual([weird, 2000, '09:05', '23:59', 0])
    await pg.exec('reset role')
    expect((await pg.query(`select 1 from trips`)).rows.length).toBeGreaterThan(0)  // 서버 테이블이 멀쩡하다
  })
})

describe('sync_apply server hardening (hostile or malformed requests)', () => {
  const call = async (uid: string, table: string, id: string, op: string, base: number, fields: unknown, client = 'dev-x') => {
    await as(uid)
    const r = await pg.query<{ r: PushResult }>('select public.sync_apply($1, $2::uuid, $3, $4, $5::jsonb, $6) as r', [table, id, op, base, JSON.stringify(fields), client])
    return r.rows[0].r
  }
  const row = async (sql: string) => { await pg.exec('reset role'); return (await pg.query<Record<string, unknown>>(sql)).rows[0] }

  it('rejects unknown tables, operations and columns (no identifier injection)', async () => {
    await syncTrip(tripId, ra.adapter, dbA)
    const id = '70000000-0000-0000-0000-000000000001'
    await expect(call(A, 'auth.users', id, 'upsert', 0, {})).rejects.toThrow(/not allowed/)
    await expect(call(A, 'trips; drop table trips', id, 'upsert', 0, {})).rejects.toThrow(/not allowed/)
    await expect(call(A, 'places', id, 'truncate', 0, {})).rejects.toThrow(/bad op/)
    await expect(call(A, 'places', id, 'upsert', 0, { trip_id: tripId, name: 'x', 'name"; drop table trips; --': 1 })).rejects.toThrow(/unknown column/)
    expect((await row(`select count(*)::int as n from trips`)).n).toBeGreaterThan(0)
  })

  it('cannot move a row to another trip, undelete it, or forge server-managed columns via update', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '원래' }, dbA)
    await syncTrip(tripId, ra.adapter, dbA)
    const t2 = (await createTrip({ name: '두 번째', country: '', city: '', startDate: '2030-07-01', endDate: '2030-07-02' }, dbA)).id
    await syncTrip(t2, ra.adapter, dbA)
    const base = (await row(`select version from itinerary_items where id = '${it.id}'`)).version as number
    await call(A, 'itinerary_items', it.id, 'upsert', base, { title: '바뀜', trip_id: t2, deleted_at: '2000-01-01T00:00:00Z', version: 999, field_versions: { title: { v: 0, c: 'x' } }, created_at: '1999-01-01T00:00:00Z' })
    const after = await row(`select title, trip_id, deleted_at, version, created_at from itinerary_items where id = '${it.id}'`)
    expect(after.title).toBe('바뀜')
    expect(after.trip_id).toBe(tripId)            // 다른 여행으로 옮겨지지 않음
    expect(after.deleted_at).toBeNull()           // 클라이언트가 삭제 시각을 조작할 수 없음
    expect(after.version).toBe(base + 1)          // 버전은 서버가 올린다
    expect(String(after.created_at)).not.toContain('1999')
  })

  it('a non-member cannot create rows in someone else trip through sync_apply', async () => {
    await syncTrip(tripId, ra.adapter, dbA)
    await expect(call(C, 'itinerary_items', '70000000-0000-0000-0000-000000000002', 'upsert', 0, { trip_id: tripId, day_number: 1, title: '침입' })).rejects.toThrow()
    await expect(call(C, 'checklist_items', '70000000-0000-0000-0000-000000000003', 'upsert', 0, { trip_id: tripId, title: '침입' })).rejects.toThrow()
    expect((await row(`select count(*)::int as n from itinerary_items where title = '침입'`)).n).toBe(0)
    // 멤버라도 다른 여행(멤버가 아닌) id를 지정해 만들 수는 없다
    const t2 = '10000000-0000-0000-0000-0000000000ff'
    await pg.exec('reset role'); await pg.exec(`insert into trips (id, owner_id, name, start_date, end_date) values ('${t2}', '${A}', '남의 여행', '2030-01-01', '2030-01-02')`)
    await expect(call(B, 'itinerary_items', '70000000-0000-0000-0000-000000000004', 'upsert', 0, { trip_id: t2, day_number: 1, title: '침입2' })).rejects.toThrow()
  })

  it('null for a NOT NULL column and wrong types are rejected as errors, never half-applied', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '정상' }, dbA)
    await syncTrip(tripId, ra.adapter, dbA)
    const base = (await row(`select version from itinerary_items where id = '${it.id}'`)).version as number
    await expect(call(A, 'itinerary_items', it.id, 'upsert', base, { title: null })).rejects.toThrow()
    await expect(call(A, 'itinerary_items', it.id, 'upsert', base, { day_number: 'abc' })).rejects.toThrow()
    await expect(call(A, 'itinerary_items', it.id, 'upsert', base, { title: '정상2', kind: 'not-a-kind' })).rejects.toThrow() // CHECK 위반이면 전체 취소
    const after = await row(`select title, version from itinerary_items where id = '${it.id}'`)
    expect([after.title, after.version]).toEqual(['정상', base])
  })

  it('malformed requests never crash with unhelpful errors: empty fields on a new row are rejected, empty update is a no-op', async () => {
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '정상' }, dbA)
    await syncTrip(tripId, ra.adapter, dbA)
    const base = (await row(`select version from itinerary_items where id = '${it.id}'`)).version as number
    const noop = await call(A, 'itinerary_items', it.id, 'upsert', base, {})
    expect(noop.status).toBe('ok'); expect(noop.version).toBe(base)
    await expect(call(A, 'itinerary_items', '70000000-0000-0000-0000-000000000005', 'upsert', 0, {})).rejects.toThrow()
  })
})

describe('convergence under random concurrent offline edits', () => {
  it('two devices that edit randomly (some offline) always end up identical to each other and to the server', async () => {
    const { ENTITIES, fromRemoteRow } = await import('./schema')
    const { moveItem } = await import('../db/itinerary')
    let seed = Number(process.env.SYNC_FUZZ_SEED ?? 20261122)
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]
    const TRIALS = Number(process.env.SYNC_FUZZ_TRIALS ?? 8) // 더 오래 돌리려면 SYNC_FUZZ_TRIALS=100 처럼 지정
    for (let trial = 0; trial < TRIALS; trial++) {
      const A_ = await newDb(), B_ = await newDb(); const rA = remoteFor(A, 'devA'), rB = remoteFor(B, 'devB')
      const tid = (await createTrip({ name: '랜덤' + trial, country: '', city: '', startDate: '2030-05-10', endDate: '2030-05-12', timeZone: 'Asia/Tokyo' }, A_)).id
      await syncTrip(tid, rA.adapter, A_)
      await pg.exec('reset role'); await pg.exec(`insert into trip_members (trip_id, user_id, role) values ('${tid}', '${B}', 'member') on conflict do nothing`)
      await downloadTrip(tid, rB.adapter, B_)
      // 장애 주입: 서버에는 반영됐지만 응답이 유실되는 경우를 무작위로 만든다(재시도가 중복·가짜 충돌을 만들지 않아야 함)
      const trace: string[] = [] // 실패 시 원인 추적용 이력
      let injectFaults = true
      for (const [label, r] of [['A', rA], ['B', rB]] as const) { const inner = r.adapter.push; r.adapter.push = async (req) => { const res = await inner(req); const lost = injectFaults && rnd() < 0.12; trace.push(`${label} PUSH ${req.table} ${req.id.slice(0, 8)} ${req.op} base=${req.baseVersion} fields=${Object.keys(req.fields).join(',')} -> ${res.status}/${res.reason ?? res.note ?? ''} v${res.version}${lost ? ' (RESPONSE LOST)' : ''}`); if (lost) throw new SyncNetworkError(); return res } }
      const devs = [{ db: A_, r: rA }, { db: B_, r: rB }]
      const { addPlace: addPlace_, deletePlace: deletePlace_ } = await import('../db/places')
      for (let step = 0; step < Number(process.env.SYNC_FUZZ_STEPS ?? 36); step++) {
        const d = pick(devs)
        const op = pick(['add', 'edit', 'edit', 'complete', 'delete', 'move', 'chk', 'shop', 'sync', 'sync', 'toggleNet', 'place', 'link', 'trip'])
        const items = (await d.db.itineraryItems.where('tripId').equals(tid).filter((i) => !i.deletedAt).toArray())
        try {
          if (op === 'add' || items.length === 0) trace.push(`${d === devs[0] ? 'A' : 'B'} ADD`)
          if (op === 'add' || items.length === 0) await addItem(tid, { dayNumber: 1 + Math.floor(rnd() * 3), kind: 'sight', title: `t${trial}-${step}`, startTime: rnd() < 0.7 ? `${String(8 + Math.floor(rnd() * 12)).padStart(2, '0')}:00` : null }, d.db)
          else if (op === 'edit') await updateItem(pick(items).id, pick([{ title: `제목${step}` }, { memo: `메모${step}` }, { startTime: `${String(8 + Math.floor(rnd() * 12)).padStart(2, '0')}:30` }, { dayNumber: 1 + Math.floor(rnd() * 3) }]), d.db)
          else if (op === 'complete') await setCompleted(pick(items).id, rnd() < 0.5, d.db)
          else if (op === 'delete') { const x = pick(items); trace.push(`${d === devs[0] ? 'A' : 'B'} LOCAL-DELETE ${x.id.slice(0, 8)} v${x.version}`); await deleteItem(x.id, d.db) }
          else if (op === 'move') await moveItem(pick(items).id, rnd() < 0.5 ? -1 : 1, d.db)
          else if (op === 'chk') { const c = await d.db.checklistItems.where('tripId').equals(tid).filter((x) => !x.deletedAt).toArray(); if (c.length && rnd() < 0.5) { const { setChecklistDone } = await import('../db/itinerary'); await setChecklistDone(pick(c).id, rnd() < 0.5, d.db) } else await addChecklist(tid, `준비${step}`, d.db) }
          else if (op === 'shop') { const s = await d.db.shoppingItems.where('tripId').equals(tid).filter((x) => !x.deletedAt).toArray(); if (s.length && rnd() < 0.6) { const x = pick(s); if (rnd() < 0.5) await setPurchased(x.id, rnd() < 0.5, rnd() < 0.5 ? 100 : undefined, d.db); else await updateShopping(x.id, { name: `상품${step}` }, d.db) } else await addShopping(tid, { name: `s${step}`, expectedPriceMinor: 100 * step }, d.db) }
          else if (op === 'place') {
            const ps = await d.db.places.where('tripId').equals(tid).filter((x) => !x.deletedAt).toArray()
            if (ps.length && rnd() < 0.3) await deletePlace_(pick(ps).id, d.db)
            else await addPlace_(tid, { name: `장소${step}`, lat: 35 + rnd(), lng: 139 + rnd() }, d.db)
          } else if (op === 'link') {
            const ps = await d.db.places.where('tripId').equals(tid).filter((x) => !x.deletedAt).toArray()
            if (ps.length && items.length) await updateItem(pick(items).id, { placeId: pick(ps).id }, d.db)
            else if (ps.length) await addShopping(tid, { name: `연결${step}`, storePlaceId: pick(ps).id }, d.db)
          } else if (op === 'trip' && d === devs[0]) await updateTrip(tid, pick([{ city: `도시${step}` }, { purpose: `목적${step}` }, { companions: [`동행${step}`] }]), d.db)
          else if (op === 'sync') await syncTrip(tid, d.r.adapter, d.db)
          else if (op === 'toggleNet') d.r.state.down = !d.r.state.down
        } catch { /* 이미 삭제된 항목을 고치는 등 정상적인 거부 */ }
      }
      // 모두 온라인으로 복구 후 충돌은 "상대 값"으로 정리하며 수렴할 때까지 동기화
      injectFaults = false
      for (const d of devs) d.r.state.down = false
      // 더 이상 오갈 변경이 없을 때까지(두 기기 모두 올린 것·받은 것·충돌이 0) 반복한다. 한 번에 끝난다고 가정하지 않는다.
      let quiet = false
      for (let round = 0; round < 12 && !quiet; round++) {
        quiet = true
        for (const d of devs) {
          const r = await syncTrip(tid, d.r.adapter, d.db)
          const cs = await d.db.conflicts.toArray()
          for (const c of cs) await resolveConflict(c.id, 'theirs', d.db)
          if (r.pushed || r.pulled || r.conflicts || cs.length || r.error) quiet = false
        }
      }
      expect(quiet, '12번 안에 수렴하지 않음').toBe(true)
      for (const [i, d] of devs.entries()) {
        await syncTrip(tid, d.r.adapter, d.db)
        const left = await pendingCount(tid, d.db)
        const q = left ? await d.db.outbox.toArray() : []
        // 실패하면 남은 큐와 관련 이력이 메시지에 함께 나온다
        expect(left, `기기 ${i === 0 ? 'A' : 'B'} 큐 잔여\n` + q.map((e) => `Q ${e.table} ${e.recordId.slice(0, 8)} ${e.op} base=${e.baseVersion} fields=${e.changedFields.join(',')} attempts=${e.attempts ?? 0}`).join('\n')).toBe(0)
        expect(await d.db.conflicts.count()).toBe(0)
      }
      // 비교: 기기 A, 기기 B, 서버가 모든 엔터티에서 같은 내용이어야 한다
      await pg.exec('reset role')
      for (const def of ENTITIES) {
        const key = (r: Record<string, unknown>) => r.id as string
        // 삭제된 행은 화면에 보이지 않으므로 "삭제됨"만 비교한다(삭제 전 마지막 편집 내용이 기기마다 달라도 무해)
        const norm = (r: Record<string, unknown>, deleted: boolean) => JSON.stringify(deleted ? { deleted } : { ...Object.fromEntries(def.fields.map((f) => [f.local, r[f.local] ?? null])), deleted })
        const local = async (d: typeof devs[number]) => new Map((await (def.table === 'trips' ? d.db.trips.where('id').equals(tid).toArray() : (d.db[def.store as 'places'].where('tripId').equals(tid).toArray()))).map((r) => [key(r as never), norm(r as never, !!(r as { deletedAt: unknown }).deletedAt)]))
        const sv = (await pg.query<{ j: Record<string, unknown> }>(`select to_jsonb(t) as j from ${def.table} t where ${def.table === 'trips' ? 'id' : 'trip_id'} = $1::uuid`, [tid])).rows
        const server = new Map(sv.map((x) => [x.j.id as string, norm(fromRemoteRow(def, x.j), !!x.j.deleted_at)]))
        const a = await local(devs[0]), b = await local(devs[1])
        // (서버에서 이미 삭제된 행은 내려받지 않았어도 된다: 사용자에게 보이지 않으므로)
        for (const [id, v] of server) for (const [label, m] of [['A', a], ['B', b]] as const) {
          if (m.get(id) === undefined && JSON.parse(v).deleted) continue
          // 실패하면 이 레코드와 관련된 업로드·삭제 이력이 메시지에 함께 나온다
          expect(m.get(id), `${def.table} ${label} ${id}\n` + trace.filter((t) => t.includes(id.slice(0, 8))).slice(-30).join('\n')).toBe(v)
        }
        // 서버에 없는 레코드가 로컬에 "살아 있는 채로" 남아 있으면 안 된다
        for (const m of [a, b]) for (const [id, v] of m) if (!server.has(id)) expect(JSON.parse(v).deleted, `${def.table} orphan ${id}`).toBe(true)
        // 서버에서 같은 id가 중복되지 않는다(PK)
        expect(new Set(sv.map((x) => x.j.id)).size).toBe(sv.length)
      }
    }
  }, 120_000)
})

describe('permissions', () => {
  it('a user who is not a member cannot download or change the trip', async () => {
    await syncTrip(tripId, ra.adapter, dbA)
    const dbC = await newDb(); const rc = remoteFor(C)
    const r = await downloadTrip(tripId, rc.adapter, dbC)
    expect(await dbC.trips.count()).toBe(0)                                // RLS가 행을 숨김
    expect(r.pulled).toBe(0)
    // 임의로 만든 변경도 거부
    await dbC.trips.add({ ...(await dbA.trips.get(tripId))!, syncState: 'pending' })
    await dbC.outbox.add({ table: 'trips', recordId: tripId, op: 'upsert', baseVersion: 1, changedFields: ['name'], createdAt: Date.now() })
    await dbC.trips.update(tripId, { name: '해킹' })
    await syncTrip(tripId, rc.adapter, dbC)
    await pg.exec('reset role')
    expect((await pg.query<{ name: string }>(`select name from trips where id = '${tripId}'`)).rows[0].name).toBe('도쿄')
  })
})

describe('local deletion of the offline copy', () => {
  it('refuses while changes are unsynced, never-synced trips or conflicts exist; works after sync', async () => {
    await expect(removeOfflineCopy(tripId, { synced: false }, dbA)).rejects.toThrow(/복구/)
    await syncTrip(tripId, ra.adapter, dbA)
    await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '미동기화' }, dbA)
    await expect(removeOfflineCopy(tripId, { synced: true }, dbA)).rejects.toThrow(/동기화/)
    await syncTrip(tripId, ra.adapter, dbA)
    await removeOfflineCopy(tripId, { synced: true }, dbA)
    expect(await dbA.trips.count()).toBe(0); expect(await dbA.itineraryItems.count()).toBe(0); expect(await dbA.syncMeta.count()).toBe(0)
    // 서버에는 그대로 있고 다시 내려받을 수 있다
    const r = await downloadTrip(tripId, ra.adapter, dbA)
    expect(r.error).toBeNull(); expect((await dbA.trips.get(tripId))!.name).toBe('도쿄')
    expect(await dbA.itineraryItems.count()).toBe(1)
  })
})

describe('trip fields', () => {
  it('admin trip edits propagate and the owner is set from the signed-in user', async () => {
    await shareWithB()
    expect((await dbA.trips.get(tripId))!.ownerId).toBe(A)
    await updateTrip(tripId, { city: '오사카', purpose: '맛집' }, dbA)
    await syncTrip(tripId, ra.adapter, dbA); await syncTrip(tripId, rb.adapter, dbB)
    const t = (await dbB.trips.get(tripId))!
    expect([t.city, t.purpose, t.ownerId]).toEqual(['오사카', '맛집', A])
  })
  it('a non-admin member editing trip info is rejected (not silently dropped) and can be discarded', async () => {
    await shareWithB()
    await updateTrip(tripId, { purpose: '내 마음대로' }, dbB)
    const r = await syncTrip(tripId, rb.adapter, dbB)
    expect(r.error).toMatch(/permission denied/)
    await pg.exec('reset role')
    expect((await pg.query<{ purpose: string }>(`select purpose from trips where id = '${tripId}'`)).rows[0].purpose).toBe('')
    expect(await pendingCount(tripId, dbB)).toBe(1)                       // 사라지지 않고 큐에 남아 사용자에게 보인다
  })
})
