// 오프라인 동기화 엔진 (로컬 우선).
//   push: 오프라인에서 쌓인 변경 큐를 서버에 적용  →  pull: 서버의 최신 변경을 로컬에 병합
// 규칙: 서로 다른 필드의 동시 수정은 병합, 같은 필드는 사용자에게 보관(덮어쓰지 않음), 삭제는 되살리지 않음, 재전송은 중복을 만들지 않음.
import { reconcileTripSafe } from '../db/reminders'
import { db as defaultDb, type TripMateDB } from '../db/local'
import type { OutboxEntry, SyncMeta2 } from '../db/types'
import { ENTITIES, entityByStore, entityByTable, fromRemoteRow, fromRemoteValue, toRemoteFields, type Ctx, type EntityDef, type RemoteRow } from './schema'

export interface PushRequest { table: string; id: string; op: 'upsert' | 'delete'; baseVersion: number; fields: Record<string, unknown>; clientId: string }
export interface PushResult { status: 'ok' | 'conflict'; version: number; reason?: 'deleted'; note?: 'not_found'; conflicts?: { field: string; remote: unknown; local: unknown }[] }

export interface RemoteAdapter {
  userId(): string
  /** 이 기기의 고정 식별자(같은 기기의 연속 수정을 충돌로 오인하지 않기 위해 서버에 함께 보낸다) */
  clientId(): string
  push(req: PushRequest): Promise<PushResult>
  /** table 의 행 중 trip(trips 는 id 일치)에 속하고 updated_at > sinceMs 인 것(삭제 표시된 행 포함)을 updated_at 순으로 */
  pull(table: string, tripId: string, sinceMs: number): Promise<RemoteRow[]>
  /**
   * 이 사용자가 지금 이 여행에 접근할 수 있는지('ok'/'denied'). 네트워크 문제는 SyncNetworkError.
   * 내보내졌거나 공유가 종료되면 서버(RLS)가 여행 행을 숨기므로 'denied'가 된다.
   */
  access?(tripId: string): Promise<'ok' | 'denied'>
  /** 내가 접근할 수 있는(참여 중인) 여행 id 목록. 다른 기기에서 만들었거나 초대받은 여행을 찾는 데 쓴다. */
  listTrips?(): Promise<string[]>
}

export const DEFAULT_TIMEOUT_MS = 30_000
export const ACCESS_LOST = '이 여행에 더 이상 접근할 수 없어요(내보내졌거나 공유가 종료됐어요).'

/** 응답이 오지 않는 서버 때문에 동기화(그리고 이를 직렬화하는 잠금)가 영원히 멈추지 않도록 시간 제한을 둔다. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SyncNetworkError('서버 응답이 너무 늦어요(시간 초과)')), ms) })
  return Promise.race([p, limit]).finally(() => clearTimeout(timer))
}

/** 네트워크 문제: 큐를 그대로 두고 나중에 다시 시도한다 */
export class SyncNetworkError extends Error { constructor(m = '네트워크에 연결할 수 없어요') { super(m); this.name = 'SyncNetworkError' } }
/** 서버가 거부(권한 없음, 잘못된 값 등): 횟수를 세어 무한 재시도를 막는다 */
export class SyncRejected extends Error { constructor(m: string) { super(m); this.name = 'SyncRejected' } }

export const MAX_ATTEMPTS = 5
export const PULL_OVERLAP_MS = 10_000 // 서버 시계/커밋 순서 차이로 놓치지 않도록 커서보다 조금 앞에서 다시 받는다(적용은 멱등)

export interface SyncReport { pushed: number; conflicts: number; pulled: number; stuck: number; error: string | null; at: number }

const locks = new WeakMap<TripMateDB, Promise<unknown>>()
/** 같은 DB에서 동기화가 동시에 두 번 돌지 않게 한 줄로 세운다(중복 전송 방지) */
function exclusive<T>(db: TripMateDB, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(db) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(db, next.catch(() => undefined))
  return next
}

const toMs = (v: unknown): number | null => { const x = fromRemoteValue('ts', v); return typeof x === 'number' && Number.isFinite(x) ? x : null }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

type Rec = Record<string, unknown> & { id: string; tripId?: string; version: number; syncState: string; deletedAt: number | null }
const table = (db: TripMateDB, def: EntityDef) => db[def.store as 'trips'] as unknown as import('dexie').Table<Rec, string>

async function getMeta(db: TripMateDB, tripId: string): Promise<SyncMeta2> {
  return (await db.syncMeta.get(tripId)) ?? { tripId, cursor: 0, lastSyncAt: null, lastPushAt: null, offlineSavedAt: null, lastError: null }
}

// ───────────────────────── push ─────────────────────────
async function pushTrip(db: TripMateDB, remote: RemoteAdapter, tripId: string, report: SyncReport, timeoutMs: number) {
  const all = await db.outbox.toArray()
  type Group = { def: EntityDef; recordId: string; entries: OutboxEntry[] }
  const groups = new Map<string, Group>()
  for (const e of all) {
    const def = entityByTable(e.table)
    if (!def) continue
    const rec = await table(db, def).get(e.recordId)
    if (!rec) { await db.outbox.delete(e.seq!); continue }           // 로컬에서 완전히 사라진 레코드의 큐는 정리
    const owner = def.table === 'trips' ? rec.id : (rec.tripId as string)
    if (owner !== tripId) continue
    const k = `${def.table}:${e.recordId}`
    if (!groups.has(k)) groups.set(k, { def, recordId: e.recordId, entries: [] })
    groups.get(k)!.entries.push(e)
  }
  const ordered = [...groups.values()].sort((a, b) => a.def.order - b.def.order)

  for (const g of ordered) {
    const { def, recordId, entries } = g
    if (entries.every((e) => (e.attempts ?? 0) >= MAX_ATTEMPTS)) { report.stuck++; continue }
    const rec = (await table(db, def).get(recordId))!
    const baseVersion = Math.min(...entries.map((e) => e.baseVersion))
    // 로컬에서 삭제된 레코드는 어떤 큐 항목이 있든 "삭제"로만 보낸다. 삭제 후에 생긴 수정 기록(예: 연결 해제)이
    // 전체 필드 업로드가 되어 서버에서 삭제된 항목이 살아나는 일을 막는 안전장치.
    const isDelete = rec.deletedAt !== null || entries.some((e) => e.op === 'delete')
    const all_ = entries.some((e) => e.changedFields.includes('*')) || baseVersion === 0
    const changed = all_ ? null : [...new Set(entries.flatMap((e) => e.changedFields))]
    const seqs = entries.map((e) => e.seq!)

    // 주의: 한 번도 올리지 않은 레코드(baseVersion 0)를 지웠더라도 삭제를 서버에 보낸다.
    // 이전에 "서버에는 반영됐지만 응답만 유실된" 업로드가 있었다면 서버에는 이미 살아 있는 행이 있기 때문이다.
    // 서버가 그런 행을 모르면 note:'not_found' 로 무해하게 끝난다.
    let fields: Record<string, unknown> = {}
    if (!isDelete) {
      fields = toRemoteFields(def, rec, changed, { userId: remote.userId() })
      if (baseVersion === 0 || all_) {
        if (def.hasTripId) fields.trip_id = tripId
        if (def.table === 'trips') fields.owner_id = remote.userId()
      }
      if (Object.keys(fields).length === 0) { await db.outbox.bulkDelete(seqs); continue }
    }

    let res: PushResult
    try {
      res = await withTimeout(remote.push({ table: def.table, id: recordId, op: isDelete ? 'delete' : 'upsert', baseVersion, fields, clientId: remote.clientId() }), timeoutMs)
    } catch (err) {
      if (err instanceof SyncNetworkError) throw err                    // 네트워크 문제: 큐 유지하고 중단
      const msg = err instanceof Error ? err.message : '서버가 변경을 거부했어요'
      await db.transaction('rw', db.outbox, async () => {
        for (const e of entries) await db.outbox.update(e.seq!, { attempts: (e.attempts ?? 0) + 1, lastError: msg.slice(0, 200) })
      })
      report.error = msg
      continue
    }

    await db.transaction('rw', [table(db, def), db.outbox, db.conflicts], async () => {
      await db.outbox.bulkDelete(seqs)
      const cur = await table(db, def).get(recordId)
      if (!cur) return
      const stillPending = (await db.outbox.where('recordId').equals(recordId).count()) > 0
      if (res.status === 'conflict' && res.reason === 'deleted') {
        // 다른 사용자가 이미 삭제함: 삭제 우선(되살리지 않음). 내 수정은 사라지므로 알려준다.
        await table(db, def).update(recordId, { deletedAt: cur.deletedAt ?? Date.now(), syncState: 'synced', version: res.version })
        if (!isDelete) await db.conflicts.put({ id: `${def.table}:${recordId}:*`, tripId, table: def.table, recordId, field: '*', kind: 'deleted', localValue: null, remoteValue: null, serverVersion: res.version, title: String(cur.name ?? cur.title ?? ''), createdAt: Date.now() })
        report.conflicts++
        return
      }
      const patch: Record<string, unknown> = { version: res.version, syncState: stillPending ? 'pending' : 'synced' }
      if (def.table === 'trips' && cur.ownerId === 'local') patch.ownerId = remote.userId()
      if (res.status === 'conflict' && res.conflicts?.length) {
        for (const c of res.conflicts) {
          const fd = def.fields.find((x) => x.remote === c.field)
          if (!fd) continue
          await db.conflicts.put({
            id: `${def.table}:${recordId}:${fd.local}`, tripId, table: def.table, recordId, field: fd.local, kind: 'field',
            localValue: cur[fd.local], remoteValue: fromRemoteValue(fd.kind, c.remote, { userId: remote.userId() }), serverVersion: res.version,
            title: String(cur.name ?? cur.title ?? ''), createdAt: Date.now(),
          })
          report.conflicts++
        }
        patch.syncState = 'conflict'
      }
      await table(db, def).update(recordId, patch)
    })
    report.pushed++
    // 서버가 한 번도 본 적 없는 여행을 로컬에서 삭제한 경우: 하위 데이터도 서버에 보낼 것이 없다
    if (def.table === 'trips' && isDelete && res.note === 'not_found') {
      const rest = (await db.outbox.toArray()).filter((e) => groups.has(`${e.table}:${e.recordId}`) && e.table !== 'trips').map((e) => e.seq!)
      await db.outbox.bulkDelete(rest)
      return
    }
  }
}

// ───────────────────────── pull ─────────────────────────
async function applyRemoteRow(db: TripMateDB, def: EntityDef, row: RemoteRow, tripId: string, report: SyncReport, ctx: Ctx) {
  const id = String(row.id)
  const remoteVersion = Number(row.version)
  const remoteDeletedAt = row.deleted_at == null ? null : toMs(row.deleted_at)
  await db.transaction('rw', [table(db, def), db.outbox, db.conflicts], async () => {
    const local = await table(db, def).get(id)
    const pending = await db.outbox.where('recordId').equals(id).toArray()
    const myConflicts = await db.conflicts.where('recordId').equals(id).toArray()
    if (!local) {
      if (remoteDeletedAt) return                                        // 삭제된 행은 새로 만들지 않는다
      const rec: Record<string, unknown> = {
        id, ...(def.hasTripId ? { tripId } : {}), ...fromRemoteRow(def, row, ctx),
        version: remoteVersion, updatedAt: Date.now(), deletedAt: null, syncState: 'synced',
      }
      await table(db, def).put(rec as Rec)
      report.pulled++
      return
    }
    if (remoteDeletedAt) {
      // 이미 같은 삭제 상태이고 보낼 것/충돌이 없으면 아무것도 하지 않는다(겹치는 구간에서 같은 행이 다시 내려올 때마다 쓰기·변경 보고를 반복하지 않도록)
      if (local.deletedAt !== null && pending.length === 0 && myConflicts.length === 0 && local.syncState === 'synced' && local.version >= remoteVersion) return
      if (local.deletedAt === null && pending.some((e) => e.op === 'upsert')) {
        await db.conflicts.put({ id: `${def.table}:${id}:*`, tripId, table: def.table, recordId: id, field: '*', kind: 'deleted', localValue: null, remoteValue: null, serverVersion: remoteVersion, title: String(local.name ?? local.title ?? ''), createdAt: Date.now() })
        report.conflicts++
      }
      if (pending.length) await db.outbox.bulkDelete(pending.map((e) => e.seq!))
      await db.conflicts.where('recordId').equals(id).filter((c) => c.kind === 'field').delete()
      await table(db, def).update(id, { deletedAt: remoteDeletedAt, syncState: 'synced', version: remoteVersion })
      report.pulled++
      return
    }
    if (local.deletedAt !== null) return                                  // 내가 지운 항목은 서버에 삭제가 전달될 때까지 되살리지 않는다
    // 버전 번호만 보고 "이미 최신"으로 건너뛰면 안 된다: 내 변경을 서버에 올릴 때 서버가 다른 사람의 변경과 합쳐 버전을
    // 올리므로, 내 로컬 버전 = 서버 버전이어도 다른 사람의 변경은 아직 못 받았을 수 있다. 내용을 비교해서 다른 필드만 받는다.
    // 내가 보낼 변경이 있거나 미해결 충돌이 있는 필드는 로컬 값을 지키고, 나머지는 서버 값을 받는다
    const protectedFields = new Set<string>()
    for (const e of pending) { if (e.changedFields.includes('*')) def.fields.forEach((f) => protectedFields.add(f.local)); else e.changedFields.forEach((f) => protectedFields.add(f)) }
    for (const c of myConflicts) if (c.kind === 'field') protectedFields.add(c.field)
    const incoming = fromRemoteRow(def, row, ctx)
    const patch: Record<string, unknown> = { version: Math.max(remoteVersion, local.version) }
    let changed = false
    for (const [k, v] of Object.entries(incoming)) if (!protectedFields.has(k) && !same(local[k], v)) { patch[k] = v; changed = true }
    patch.syncState = myConflicts.length ? 'conflict' : pending.length ? 'pending' : 'synced'
    if (changed || patch.version !== local.version || patch.syncState !== local.syncState) await table(db, def).update(id, patch)
    if (changed) report.pulled++
  })
}

export type ProgressFn = (done: number, total: number, label: string) => void
const STAGE_LABEL: Record<string, string> = { trips: '여행 정보', places: '장소', itinerary_items: '일정', checklist_items: '준비물', expense_categories: '지출 항목', shopping_items: '쇼핑 리스트', expenses: '경비' }

async function pullTrip(db: TripMateDB, remote: RemoteAdapter, tripId: string, report: SyncReport, fromScratch: boolean, timeoutMs: number, onProgress?: ProgressFn) {
  const meta = await getMeta(db, tripId)
  // 커서는 테이블마다 따로 둔다. 하나의 커서를 공유하면, 테이블 A를 받은 뒤 B를 받는 사이에 A에 생긴 변경이
  // B의 더 최신 시각 뒤로 밀려 영영 놓칠 수 있다.
  const cursors: Record<string, number> = { ...(meta.cursors ?? {}) }
  for (const [i, def] of ENTITIES.entries()) {
    onProgress?.(i, ENTITIES.length, STAGE_LABEL[def.table] ?? def.table)
    const prev = cursors[def.table] ?? 0
    const since = fromScratch ? 0 : Math.max(0, prev - PULL_OVERLAP_MS)
    const rows = await withTimeout(remote.pull(def.table, tripId, since), timeoutMs)
    let newest = prev
    for (const r of rows) {
      await applyRemoteRow(db, def, r, tripId, report, { userId: remote.userId() })
      const u = toMs(r.updated_at)
      if (u !== null && u > newest) newest = u
    }
    cursors[def.table] = newest
    await db.syncMeta.put({ ...(await getMeta(db, tripId)), cursors, cursor: Math.max(0, ...Object.values(cursors)) }) // 테이블 하나를 끝낼 때마다 저장(중간에 끊겨도 이어서)
  }
  onProgress?.(ENTITIES.length, ENTITIES.length, '완료')
}

// ───────────────────────── 공개 API ─────────────────────────
export function syncTrip(tripId: string, remote: RemoteAdapter, db: TripMateDB = defaultDb, opts: { fromScratch?: boolean; onProgress?: ProgressFn; timeoutMs?: number } = {}): Promise<SyncReport> {
  return exclusive(db, async () => {
    const report: SyncReport = { pushed: 0, conflicts: 0, pulled: 0, stuck: 0, error: null, at: Date.now() }
    try {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      // 서버가 이미 아는 여행인데 접근이 막혔다면(내보내짐·공유 종료) 더 보내거나 받지 않고, 이 기기의 사본을 어떻게 할지 사용자가 정하게 한다.
      const localTrip = await db.trips.get(tripId)
      const knownToServer = !!localTrip && (localTrip.version > 0 || !!(await getMeta(db, tripId)).lastSyncAt)
      if (remote.access && knownToServer) {
        const a = await withTimeout(remote.access(tripId), timeoutMs)
        const m0 = await getMeta(db, tripId)
        if (a === 'denied') {
          await db.syncMeta.put({ ...m0, accessLost: true, lastError: ACCESS_LOST })
          report.error = ACCESS_LOST
          return report
        }
        if (m0.accessLost) await db.syncMeta.put({ ...m0, accessLost: false, lastError: null }) // 다시 초대받아 접근이 복구됨
      }
      await pushTrip(db, remote, tripId, report, timeoutMs)
      await db.syncMeta.put({ ...(await getMeta(db, tripId)), lastPushAt: Date.now() })
      await pullTrip(db, remote, tripId, report, !!opts.fromScratch, timeoutMs, opts.onProgress)
      const m = await getMeta(db, tripId)
      await db.syncMeta.put({ ...m, lastSyncAt: Date.now(), lastError: report.error })
    } catch (err) {
      report.error = err instanceof SyncNetworkError ? err.message : err instanceof Error ? err.message : '동기화에 실패했어요'
      const m = await getMeta(db, tripId)
      await db.syncMeta.put({ ...m, lastError: report.error })
    }
    await reconcileTripSafe(tripId, db) // 받아온 일정 변경을 알림 예약에 반영
    return report
  })
}

/**
 * 서버에는 있는데 이 기기에 없는 여행(다른 기기에서 만들었거나 초대로 참여한 여행)을 찾아 내려받는다.
 * 사용자가 이 기기에서 일부러 사본을 지운 여행은 다시 내려받지 않는다.
 */
export async function discoverTrips(remote: RemoteAdapter, db: TripMateDB = defaultDb, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string[]> {
  if (!remote.listTrips) return []
  const ids = await withTimeout(remote.listTrips(), timeoutMs)
  const got: string[] = []
  for (const id of ids) {
    if ((await db.trips.get(id)) || (await db.exclusions.get(id))) continue
    const r = await downloadTrip(id, remote, db)
    if (!r.error) got.push(id)
  }
  return got
}

/** "오프라인 저장": 서버의 전체 여행 정보를 내려받아 이 기기에 보관한다 */
export async function downloadTrip(tripId: string, remote: RemoteAdapter, db: TripMateDB = defaultDb, onProgress?: ProgressFn): Promise<SyncReport> {
  await db.exclusions.delete(tripId) // 사용자가 직접 내려받는 것이므로 "지운 여행" 표시를 푼다
  const r = await syncTrip(tripId, remote, db, { fromScratch: true, onProgress })
  if (!r.error) await db.syncMeta.put({ ...(await getMeta(db, tripId)), offlineSavedAt: Date.now() })
  return r
}

/** 충돌 해결: 'mine' = 내 값을 서버에 다시 보냄, 'theirs' = 서버 값을 받아들임 */
export async function resolveConflict(conflictId: string, choice: 'mine' | 'theirs', db: TripMateDB = defaultDb) {
  await db.transaction('rw', [db.conflicts, db.outbox, ...ENTITIES.map((e) => table(db, e))], async () => {
    const c = await db.conflicts.get(conflictId)
    if (!c) return
    const def = entityByTable(c.table)!
    const rec = await table(db, def).get(c.recordId)
    if (rec && c.kind === 'field') {
      if (choice === 'theirs') await table(db, def).update(c.recordId, { [c.field]: c.remoteValue })
      else await db.outbox.add({ table: c.table, recordId: c.recordId, op: 'upsert', baseVersion: c.serverVersion, changedFields: [c.field], createdAt: Date.now() })
    }
    await db.conflicts.delete(conflictId)
    if (rec) {
      const left = await db.conflicts.where('recordId').equals(c.recordId).count()
      const pend = await db.outbox.where('recordId').equals(c.recordId).count()
      await table(db, def).update(c.recordId, { syncState: left ? 'conflict' : pend ? 'pending' : 'synced', updatedAt: Date.now() })
    }
  })
}

/**
 * 서버가 계속 거부한 변경(권한 없음 등)을 버리고 서버의 값으로 되돌린다.
 * 거부된 변경을 큐에 영원히 남겨 두면 로컬 화면과 서버가 계속 달라지기 때문에, 사용자가 선택해서 정리할 수 있게 한다.
 */
export async function discardRejected(tripId: string, remote: RemoteAdapter, db: TripMateDB = defaultDb): Promise<SyncReport> {
  const all = await db.outbox.toArray()
  const drop: number[] = []
  for (const e of all) {
    if ((e.attempts ?? 0) < MAX_ATTEMPTS) continue
    const def = entityByTable(e.table); if (!def) continue
    const rec = await table(db, def).get(e.recordId); if (!rec) continue
    if ((def.table === 'trips' ? rec.id : rec.tripId) === tripId) drop.push(e.seq!)
  }
  if (drop.length) await db.outbox.bulkDelete(drop)
  return syncTrip(tripId, remote, db, { fromScratch: true })
}

/**
 * 접근이 막힌 여행의 이 기기 사본을 정리한다. 서버에 올릴 수 없는 변경도 함께 버리므로 사용자가 확인한 뒤에만 호출한다.
 */
export async function discardLocalCopy(tripId: string, db: TripMateDB = defaultDb) {
  await db.transaction('rw', [...ENTITIES.map((e) => table(db, e)), db.syncMeta, db.conflicts, db.reminders, db.expenses, db.members, db.outbox, db.exclusions], async () => {
    const ownerOf = async (e: EntityDef, id: string) => (e.table === 'trips' ? id : ((await table(db, e).get(id))?.tripId as string | undefined))
    for (const q of await db.outbox.toArray()) {
      const def = entityByTable(q.table); if (!def) continue
      if ((await ownerOf(def, q.recordId)) === tripId) await db.outbox.delete(q.seq!)
    }
    for (const e of ENTITIES) {
      if (e.table === 'trips') await db.trips.delete(tripId)
      else await table(db, e).where('tripId').equals(tripId).delete()
    }
    await db.expenses.where('tripId').equals(tripId).delete(); await db.conflicts.where('tripId').equals(tripId).delete()
    await db.members.where('tripId').equals(tripId).delete(); await db.reminders.where('tripId').equals(tripId).delete(); await db.syncMeta.delete(tripId)
    await db.exclusions.put({ tripId, at: Date.now() })
  })
}

export async function pendingCount(tripId: string, db: TripMateDB = defaultDb): Promise<number> {
  const all = await db.outbox.toArray()
  let n = 0
  for (const e of all) {
    const def = entityByTable(e.table); if (!def) continue
    const rec = await table(db, def).get(e.recordId); if (!rec) continue
    if ((def.table === 'trips' ? rec.id : rec.tripId) === tripId) n++
  }
  return n
}

/** 이 기기의 여행 사본 삭제. 서버에 아직 올리지 않은 변경이나 미해결 충돌이 있으면 데이터 유실을 막기 위해 거부한다. */
export async function removeOfflineCopy(tripId: string, opts: { synced: boolean }, db: TripMateDB = defaultDb) {
  if (!opts.synced) throw new Error('서버에 저장되지 않은 여행이라 삭제하면 복구할 수 없어요.')
  if ((await pendingCount(tripId, db)) > 0) throw new Error('아직 서버에 올리지 않은 변경이 있어요. 동기화한 뒤 삭제하세요.')
  if ((await db.conflicts.where('tripId').equals(tripId).count()) > 0) throw new Error('해결하지 않은 충돌이 있어요.')
  await db.transaction('rw', [...ENTITIES.map((e) => table(db, e)), db.syncMeta, db.conflicts, db.reminders, db.expenses, db.members, db.exclusions], async () => {
    for (const e of ENTITIES) {
      if (e.table === 'trips') await db.trips.delete(tripId)
      else await table(db, e).where('tripId').equals(tripId).delete()
    }
    await db.expenses.where('tripId').equals(tripId).delete()
    await db.members.where('tripId').equals(tripId).delete()
    await db.syncMeta.delete(tripId); await db.reminders.where('tripId').equals(tripId).delete()
    await db.exclusions.put({ tripId, at: Date.now() }) // 사용자가 지운 사본은 자동으로 다시 내려받지 않는다
  })
}

export { entityByStore }
