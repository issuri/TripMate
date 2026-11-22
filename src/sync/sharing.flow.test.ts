// 통합 시나리오: 실제 PostgreSQL + 클라이언트 SharingApi/동기화 엔진.
// 관리자(A)가 여행을 만들고 → 초대 → 동행자(B)가 참여·내려받기 → 서로 편집·동기화 → 내보내기/탈퇴/공유 종료까지.
import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { addItem, updateItem, updateTrip } from '../db/itinerary'
import { TripMateDB } from '../db/local'
import { addShopping } from '../db/shopping'
import { createTrip } from '../db/trips'
import { ACCESS_LOST, discardLocalCopy, discoverTrips, downloadTrip, removeOfflineCopy, SyncNetworkError, syncTrip, type PushRequest, type PushResult, type RemoteAdapter } from './engine'
import { createSharingApi, extractInviteCode, inviteLink, myRole, refreshMembers, RPC_PARAMS, type SharingApi } from './sharing'
import { createTestServer, U, type TestServer } from './testServer'

let s: TestServer
beforeAll(async () => { s = await createTestServer() })

interface Device { uid: string; db: TripMateDB; remote: RemoteAdapter; api: SharingApi; state: { down: boolean } }

async function device(uid: string, name: string): Promise<Device> {
  const db = new TripMateDB('f-' + Math.random()); await db.open()
  const state = { down: false }
  const guard = () => { if (state.down) throw new SyncNetworkError() }
  const remote: RemoteAdapter = {
    userId: () => uid, clientId: () => 'dev-' + name,
    async push(req: PushRequest) { guard(); await s.as(uid); try { return (await s.pg.query<{ r: PushResult }>('select public.sync_apply($1, $2::uuid, $3, $4, $5::jsonb, $6) as r', [req.table, req.id, req.op, req.baseVersion, JSON.stringify(req.fields), req.clientId])).rows[0].r } catch (e) { throw new Error((e as Error).message) } },
    async pull(table, tripId, since) { guard(); await s.as(uid); return (await s.pg.query<{ j: Record<string, unknown> }>(`select to_jsonb(t) as j from public.${table} t where ${table === 'trips' ? 'id' : 'trip_id'} = $1::uuid and updated_at > to_timestamp($2 / 1000.0) order by updated_at, id`, [tripId, since])).rows.map((x) => x.j) },
    async listTrips() { guard(); await s.as(uid); return (await s.pg.query<{ id: string }>(`select id from public.trips where deleted_at is null`)).rows.map((r) => r.id) },
    async access(tripId) { guard(); await s.as(uid); return (await s.pg.query(`select id from public.trips where id = $1::uuid`, [tripId])).rows.length ? 'ok' : 'denied' },
  }
  const fetchGuard = () => { if (state.down) throw new TypeError('Failed to fetch') }   // 실제 fetch 실패와 같은 오류
  const rpc = async (fn: keyof typeof RPC_PARAMS, args: Record<string, unknown>) => {
    fetchGuard(); await s.as(uid)
    const names = RPC_PARAMS[fn]; const vals = names.map((n) => args[n]); const ph = vals.map((_, i) => `$${i + 1}`).join(', ')
    // 집합을 돌려주는 함수는 PostgREST처럼 행 배열로 돌려준다
    if (fn === 'list_members') return (await s.pg.query(`select * from public.${fn}(${ph})`, vals as never)).rows
    const r = await s.pg.query<{ r: unknown }>(`select public.${fn}(${ph}) as r`, vals as never)
    return r.rows[0].r
  }
  const list = async (tripId: string) => { fetchGuard(); await s.as(uid); return (await s.pg.query<Record<string, unknown>>(`select * from public.trip_invites where trip_id = $1 order by created_at desc`, [tripId])).rows }
  return { uid, db, remote, api: createSharingApi(rpc, list), state }
}

let A: Device, B: Device, C: Device, tripId: string
beforeEach(async () => {
  await s.admin(); await s.pg.exec('truncate trip_members, trip_invites, join_attempts, trips, profiles cascade')
  A = await device(U.A, 'A'); B = await device(U.B, 'B'); C = await device(U.C, 'C')
  await A.api.setDisplayName('지은'); await B.api.setDisplayName('민수'); await C.api.setDisplayName('하준')
  tripId = (await createTrip({ name: '도쿄', country: '일본', city: '도쿄', startDate: '2030-05-10', endDate: '2030-05-12', timeZone: 'Asia/Tokyo' }, A.db)).id
  expect((await syncTrip(tripId, A.remote, A.db)).error).toBeNull()
})

/** A가 초대 → B가 코드로 참여 → 내려받기 */
async function inviteAndJoin(d: Device, via: 'code' | 'link' = 'code') {
  const code = await A.api.createInvite(tripId)
  const input = via === 'link' ? inviteLink('https://tripmate.example', code) : code
  const joined = await d.api.join(input)
  expect(joined.tripId).toBe(tripId)
  expect((await downloadTrip(tripId, d.remote, d.db)).error).toBeNull()
  await refreshMembers(tripId, d.api, d.db)
  return code
}

describe('invite → join → collaborate', () => {
  it('the invited companion joins with a code or a pasted link and gets the full trip, members list and role', async () => {
    await A.api.createInvite(tripId)                                       // (미사용 초대가 있어도 무관)
    await inviteAndJoin(B, 'link')
    expect((await B.db.trips.get(tripId))!.name).toBe('도쿄')
    expect(await B.db.checklistItems.where('tripId').equals(tripId).count()).toBeGreaterThan(0)
    const names = (await B.db.members.where('tripId').equals(tripId).toArray()).map((m) => `${m.displayName}:${m.role}:${m.isMe}`).sort()
    expect(names).toEqual(['지은:admin:false', '민수:member:true'].sort())
    expect(await myRole(tripId, B.db)).toBe('member')
    await refreshMembers(tripId, A.api, A.db); expect(await myRole(tripId, A.db)).toBe('admin')
  })

  it("companions' edits reach the other side in both directions, and shared shopping/itinerary stay consistent", async () => {
    await inviteAndJoin(B)
    const it = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: 'A가 만든 일정', startTime: '10:00' }, A.db)
    await addShopping(tripId, { name: '과자', expectedPriceMinor: 500 }, B.db)
    await syncTrip(tripId, A.remote, A.db); await syncTrip(tripId, B.remote, B.db); await syncTrip(tripId, A.remote, A.db)
    expect((await B.db.itineraryItems.get(it.id))!.title).toBe('A가 만든 일정')
    expect((await A.db.shoppingItems.toArray()).map((x) => x.name)).toEqual(['과자'])
    await updateItem(it.id, { memo: 'B가 쓴 메모' }, B.db); await updateItem(it.id, { startTime: '11:00' }, A.db)
    await syncTrip(tripId, B.remote, B.db); await syncTrip(tripId, A.remote, A.db); await syncTrip(tripId, B.remote, B.db)
    for (const d of [A, B]) { const x = (await d.db.itineraryItems.get(it.id))!; expect([x.memo, x.startTime]).toEqual(['B가 쓴 메모', '11:00']) }
  })

  it('a normal member cannot change trip info (rejected, surfaced) while an admin can', async () => {
    await inviteAndJoin(B)
    await updateTrip(tripId, { purpose: 'B의 마음대로' }, B.db)
    const r = await syncTrip(tripId, B.remote, B.db)
    expect(r.error).toBeTruthy()
    await s.admin(); expect((await s.pg.query<{ purpose: string }>(`select purpose from trips`)).rows[0].purpose).toBe('')
    await A.api.setRole(tripId, U.B, 'admin')                                // 관리자로 지정되면 같은 변경이 반영된다
    for (let i = 0; i < 2; i++) await syncTrip(tripId, B.remote, B.db)
    await s.admin(); expect((await s.pg.query<{ purpose: string }>(`select purpose from trips`)).rows[0].purpose).toBe('B의 마음대로')
  })
})

describe('discovering shared trips and local-copy exclusions', () => {
  it('a joined trip whose download failed is found and downloaded automatically later', async () => {
    const code = await A.api.createInvite(tripId)
    await B.api.join(code)                                                    // 참여는 됐지만 내려받기는 하지 않은 상태(네트워크 실패 등)
    expect(await B.db.trips.count()).toBe(0)
    const got = await discoverTrips(B.remote, B.db)
    expect(got).toEqual([tripId])
    expect((await B.db.trips.get(tripId))!.name).toBe('도쿄')
    expect(await discoverTrips(B.remote, B.db)).toEqual([])                   // 이미 있으면 다시 받지 않는다
  })
  it("a trip created on one device appears on the same user's other device", async () => {
    const A2 = await device(U.A, 'A-phone')
    expect(await discoverTrips(A2.remote, A2.db)).toEqual([tripId])
    expect((await A2.db.trips.get(tripId))!.ownerId).toBe(U.A)
  })
  it('a copy the user deleted on purpose is not re-downloaded automatically, but an explicit download works', async () => {
    await inviteAndJoin(B)
    await removeOfflineCopy(tripId, { synced: true }, B.db)
    expect(await B.db.trips.count()).toBe(0)
    expect(await discoverTrips(B.remote, B.db)).toEqual([])                   // 일부러 지운 사본은 되살리지 않는다
    expect((await downloadTrip(tripId, B.remote, B.db)).error).toBeNull()      // 사용자가 직접 내려받으면 다시 사용 가능
    expect(await B.db.trips.count()).toBe(1)
    expect(await B.db.exclusions.count()).toBe(0)
  })
  it('after leaving or being removed the trip is no longer listed', async () => {
    await inviteAndJoin(B)
    await A.api.removeMember(tripId, U.B)
    expect(await B.remote.listTrips!()).toEqual([])
  })
})

describe('role fallback when the members cache is missing', () => {
  it('local-only trips are admin; synced trips default to member unless I am the owner', async () => {
    const local = (await createTrip({ name: '로컬', country: '', city: '', startDate: '2030-06-01', endDate: '2030-06-02' }, A.db)).id
    expect(await myRole(local, A.db, U.A)).toBe('admin')
    expect(await myRole(tripId, A.db, U.A)).toBe('admin')                      // 소유자
    await inviteAndJoin(B)
    await B.db.members.clear()                                                // 사본이 사라진 경우
    expect(await myRole(tripId, B.db, U.B)).toBe('member')                    // 가장 낮은 권한으로 본다(최소 권한)
    expect(await myRole(tripId, B.db, null)).toBe('member')
  })
})

describe('losing access', () => {
  it('a removed member is detected on the next sync, stops syncing, keeps a local copy and can discard it', async () => {
    await inviteAndJoin(B)
    const mine = await addItem(tripId, { dayNumber: 1, kind: 'sight', title: '내보내진 뒤 만든 일정' }, B.db)
    await A.api.removeMember(tripId, U.B)
    const r = await syncTrip(tripId, B.remote, B.db)
    expect(r.error).toBe(ACCESS_LOST)
    expect((await B.db.syncMeta.get(tripId))!.accessLost).toBe(true)
    expect(await B.db.itineraryItems.get(mine.id)).toBeDefined()           // 이 기기의 사본은 남아 있다(사용자가 정한다)
    await s.admin(); expect((await s.pg.query(`select 1 from itinerary_items where id = '${mine.id}'`)).rows).toHaveLength(0) // 서버에는 올라가지 않았다
    await syncTrip(tripId, B.remote, B.db)                                 // 다시 시도해도 같은 상태
    expect((await B.db.syncMeta.get(tripId))!.accessLost).toBe(true)
    expect(await refreshMembers(tripId, B.api, B.db)).toBe('forbidden')   // 멤버 목록 사본은 지워진다
    expect(await B.db.members.where('tripId').equals(tripId).count()).toBe(0)
    await discardLocalCopy(tripId, B.db)
    expect(await B.db.trips.count()).toBe(0); expect(await B.db.outbox.count()).toBe(0); expect(await B.db.itineraryItems.count()).toBe(0)
  })

  it('re-inviting a removed member restores access and clears the lost-access state', async () => {
    await inviteAndJoin(B)
    await A.api.removeMember(tripId, U.B); await syncTrip(tripId, B.remote, B.db)
    expect((await B.db.syncMeta.get(tripId))!.accessLost).toBe(true)
    await B.api.join(await A.api.createInvite(tripId))
    expect((await syncTrip(tripId, B.remote, B.db)).error).toBeNull()
    expect((await B.db.syncMeta.get(tripId))!.accessLost).toBe(false)
  })

  it('end_sharing cuts everyone off but the admin; the admin keeps working normally', async () => {
    await inviteAndJoin(B); await inviteAndJoin(C)
    expect(await A.api.endSharing(tripId)).toBe(2)
    expect((await syncTrip(tripId, B.remote, B.db)).error).toBe(ACCESS_LOST)
    expect((await syncTrip(tripId, C.remote, C.db)).error).toBe(ACCESS_LOST)
    expect((await syncTrip(tripId, A.remote, A.db)).error).toBeNull()
    expect((await A.api.listMembers(tripId)).filter((m) => m.status === 'active')).toHaveLength(1)
  })

  it('a member who leaves is detected the same way; being offline never triggers a false access-lost', async () => {
    await inviteAndJoin(B)
    B.state.down = true
    const off = await syncTrip(tripId, B.remote, B.db)
    expect(off.error).toMatch(/네트워크/)
    expect((await B.db.syncMeta.get(tripId))?.accessLost).not.toBe(true)   // 오프라인은 "접근 상실"이 아니다
    B.state.down = false
    await B.api.leave(tripId)
    expect((await syncTrip(tripId, B.remote, B.db)).error).toBe(ACCESS_LOST)
  })

  it('a trip that was never uploaded is never reported as access-lost', async () => {
    const local = (await createTrip({ name: '로컬 전용', country: '', city: '', startDate: '2030-06-01', endDate: '2030-06-02' }, B.db)).id
    const r = await syncTrip(local, B.remote, B.db)
    expect(r.error).toBeNull()
    expect((await B.db.syncMeta.get(local))!.accessLost).toBeFalsy()
  })
})

describe('client helpers and error handling', () => {
  it('extractInviteCode finds codes in raw text, pasted links and chat messages; rejects garbage', () => {
    expect(extractInviteCode('abcd-1234-ef56')).toBe('ABCD-1234-EF56')
    expect(extractInviteCode('abcd 1234 ef56')).toBe('ABCD-1234-EF56')
    expect(extractInviteCode('https://tripmate.example/join#ABCD-1234-EF56')).toBe('ABCD-1234-EF56')
    expect(extractInviteCode('https://tripmate.example/join#abcd1234ef56  ')).toBe('ABCD-1234-EF56')
    expect(extractInviteCode('')).toBeNull(); expect(extractInviteCode('hello world')).toBeNull(); expect(extractInviteCode('ABCD-1234')).toBeNull()
    expect(inviteLink('https://x.test', 'AAAA-BBBB-CCCC')).toBe('https://x.test/join#AAAA-BBBB-CCCC')   // 코드는 # 뒤: 서버 로그에 남지 않는다
  })
  it('malformed codes never reach the server (no wasted attempts); server rejections become readable Korean errors', async () => {
    const before = async () => { await s.admin(); return (await s.pg.query<{ n: number }>('select count(*)::int as n from join_attempts')).rows[0].n }
    const n0 = await before()
    await expect(B.api.join('not a code')).rejects.toMatchObject({ code: 'invalid_invite', message: expect.stringContaining('초대 코드') })
    expect(await before()).toBe(n0)
    await expect(B.api.join('AAAA-BBBB-CCCC')).rejects.toMatchObject({ code: 'invalid_invite' })
    expect(await before()).toBe(n0 + 1)
    await expect(B.api.createInvite(tripId)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('관리자') })
    await inviteAndJoin(B)
    await expect(A.api.setRole(tripId, U.A, 'member')).rejects.toMatchObject({ code: 'last_admin' })
    await expect(A.api.removeMember(tripId, U.A)).rejects.toMatchObject({ code: 'use_leave' })
    for (let i = 0; i < 8; i++) await C.api.join(`BAD${i}-0000-0000`).catch(() => undefined)
    await expect(C.api.join('AAAA-BBBB-CCCC')).rejects.toMatchObject({ code: 'too_many_attempts', message: expect.stringContaining('10분') })
  })
  it('lists invites without exposing plaintext, and revoked invites stop working', async () => {
    const code = await A.api.createInvite(tripId, { hours: 24, maxUses: 3 })
    const [inv] = await A.api.listInvites(tripId)
    expect(inv).toMatchObject({ maxUses: 3, usedCount: 0, revoked: false })
    expect(JSON.stringify(inv)).not.toContain(code.replace(/-/g, ''))
    await A.api.revokeInvite(inv.id)
    await expect(B.api.join(code)).rejects.toMatchObject({ code: 'invalid_invite' })
    expect((await A.api.listInvites(tripId))[0].revoked).toBe(true)
  })
  it('network failures become a retryable message', async () => {
    A.state.down = true
    await expect(A.api.createInvite(tripId)).rejects.toMatchObject({ code: 'network' })
  })
})
