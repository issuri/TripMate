// 동행자 공유: 서버 RPC(0007_sharing.sql) 호출과 순수 도우미. 권한 판단의 기준은 항상 서버(RLS/RPC)이고,
// 여기서 계산하는 권한은 화면에서 쓸 수 없는 버튼을 숨기기 위한 것이다.
import type { SupabaseClient } from '@supabase/supabase-js'
import { db as defaultDb, type TripMateDB } from '../db/local'
import type { MemberRow } from '../db/types'

export type Role = 'admin' | 'member'
export interface Member { userId: string; displayName: string; role: Role; status: 'active' | 'left' | 'removed'; joinedAt: number; isMe: boolean }
export interface InviteInfo { id: string; expiresAt: number; maxUses: number; usedCount: number; revoked: boolean; createdAt: number }

/** RPC 이름 → 인자 이름 순서 (PostgREST는 이름 있는 인자를 요구하고, 테스트용 SQL 호출은 순서를 요구한다) */
export const RPC_PARAMS = {
  create_invite: ['p_trip', 'p_expires_hours', 'p_max_uses'], join_trip: ['p_code'], revoke_invite: ['p_invite'], list_members: ['p_trip'],
  set_member_role: ['p_trip', 'p_user', 'p_role'], remove_member: ['p_trip', 'p_user'], leave_trip: ['p_trip'], end_sharing: ['p_trip'], upsert_profile: ['p_name'],
} as const
export type RpcName = keyof typeof RPC_PARAMS
export type Rpc = (fn: RpcName, args: Record<string, unknown>) => Promise<unknown>
export type InviteLister = (tripId: string) => Promise<Record<string, unknown>[]>

export class SharingError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.name = 'SharingError'; this.code = code }
}

const MESSAGES: Record<string, string> = {
  forbidden: '권한이 없어요. 이 작업은 관리자만 할 수 있어요.',
  last_admin: '마지막 관리자는 바꾸거나 나갈 수 없어요. 먼저 다른 사람을 관리자로 지정하세요.',
  use_leave: '자기 자신은 내보낼 수 없어요. "여행에서 나가기"를 사용하세요.',
  not_found: '대상을 찾을 수 없어요.',
  too_many_invites: '사용할 수 있는 초대가 너무 많아요. 안 쓰는 초대를 취소하고 다시 만드세요.',
  invalid_argument: '입력값이 올바르지 않아요.',
  not_authenticated: '로그인이 필요해요.',
  invalid_invite: '초대 코드가 올바르지 않거나 만료됐어요.',
  too_many_attempts: '잘못된 코드를 여러 번 입력했어요. 10분 뒤에 다시 시도하세요.',
  network: '인터넷에 연결할 수 없어요. 연결을 확인하고 다시 시도하세요.',
}
export const sharingMessage = (code: string) => MESSAGES[code] ?? '요청을 처리하지 못했어요.'

/** 서버 오류 메시지에서 우리가 정의한 코드를 찾아 SharingError 로 바꾼다 */
export function toSharingError(e: unknown): SharingError {
  if (e instanceof SharingError) return e
  const msg = e instanceof Error ? e.message : String(e)
  // onLine 이 값 자체가 없는 환경(테스트, 일부 웹뷰)에서 "오프라인"으로 오판하지 않도록 정확히 false 일 때만 오프라인으로 본다
  if (/failed to fetch|network|load failed/i.test(msg) || (typeof navigator !== 'undefined' && navigator.onLine === false)) return new SharingError('network', MESSAGES.network)
  const code = Object.keys(MESSAGES).find((c) => msg.includes(c))
  return new SharingError(code ?? 'unknown', sharingMessage(code ?? 'unknown'))
}

// ───────── 초대 코드 도우미 ─────────
/** 사용자가 입력/붙여넣은 문자열(코드, 초대 링크 전체 등)에서 XXXX-XXXX-XXXX 형식의 코드를 뽑는다. 없으면 null. */
export function extractInviteCode(input: string): string | null {
  const text = decodeURIComponent((input ?? '').trim()).toUpperCase()
  const tail = text.includes('#') ? text.slice(text.lastIndexOf('#') + 1) : text
  const m = /([0-9A-F]{4})[\s-]?([0-9A-F]{4})[\s-]?([0-9A-F]{4})\s*$/.exec(tail)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}
/** 초대 링크. 코드는 # 뒤에 둔다: 서버 로그·리퍼러로 전송되지 않는다. */
export const inviteLink = (origin: string, code: string) => `${origin}/join#${code}`
export const inviteMessage = (tripName: string, link: string, code: string) => `"${tripName}" 여행에 초대합니다.\n초대 링크: ${link}\n초대 코드: ${code}`

// ───────── 권한 도우미 (화면용) ─────────
export const can = {
  editTripInfo: (r: Role) => r === 'admin',
  deleteTrip: (r: Role) => r === 'admin',
  manageMembers: (r: Role) => r === 'admin',
}

// ───────── API ─────────
export interface SharingApi {
  createInvite(tripId: string, opts?: { hours?: number; maxUses?: number }): Promise<string>
  join(code: string): Promise<{ tripId: string; already: boolean }>
  listMembers(tripId: string): Promise<Member[]>
  listInvites(tripId: string): Promise<InviteInfo[]>
  revokeInvite(id: string): Promise<void>
  setRole(tripId: string, userId: string, role: Role): Promise<void>
  removeMember(tripId: string, userId: string): Promise<void>
  leave(tripId: string): Promise<void>
  endSharing(tripId: string): Promise<number>
  setDisplayName(name: string): Promise<void>
}

const ms = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : Number(v))

export function createSharingApi(rpc: Rpc, listInvitesRaw: InviteLister): SharingApi {
  const call = async <T>(fn: RpcName, args: Record<string, unknown>): Promise<T> => {
    try { return (await rpc(fn, args)) as T } catch (e) { throw toSharingError(e) }
  }
  return {
    createInvite: (tripId, o = {}) => call<string>('create_invite', { p_trip: tripId, p_expires_hours: o.hours ?? 168, p_max_uses: o.maxUses ?? 5 }),
    async join(code) {
      const c = extractInviteCode(code)
      if (!c) throw new SharingError('invalid_invite', MESSAGES.invalid_invite)       // 형식이 틀린 코드는 서버에 보내지 않는다(시도 횟수 낭비 방지)
      const r = await call<{ status: string; code?: string; trip_id?: string; already?: boolean }>('join_trip', { p_code: c })
      if (r.status !== 'ok' || !r.trip_id) throw new SharingError(r.code ?? 'invalid_invite', sharingMessage(r.code ?? 'invalid_invite'))
      return { tripId: r.trip_id, already: !!r.already }
    },
    async listMembers(tripId) {
      const rows = await call<Record<string, unknown>[]>('list_members', { p_trip: tripId })
      return rows.map((r) => ({ userId: String(r.user_id), displayName: String(r.display_name ?? ''), role: r.role as Role, status: r.status as Member['status'], joinedAt: ms(r.joined_at), isMe: !!r.is_me }))
    },
    async listInvites(tripId) {
      try {
        return (await listInvitesRaw(tripId)).map((r) => ({ id: String(r.id), expiresAt: ms(r.expires_at), maxUses: Number(r.max_uses), usedCount: Number(r.used_count), revoked: !!r.revoked, createdAt: ms(r.created_at) }))
      } catch (e) { throw toSharingError(e) }
    },
    revokeInvite: (id) => call('revoke_invite', { p_invite: id }),
    setRole: (tripId, userId, role) => call('set_member_role', { p_trip: tripId, p_user: userId, p_role: role }),
    removeMember: (tripId, userId) => call('remove_member', { p_trip: tripId, p_user: userId }),
    leave: (tripId) => call('leave_trip', { p_trip: tripId }),
    endSharing: async (tripId) => Number(await call<number>('end_sharing', { p_trip: tripId })),
    setDisplayName: (name) => call('upsert_profile', { p_name: name }),
  }
}

/** Supabase 클라이언트로 SharingApi 만들기 */
export function createSupabaseSharing(client: SupabaseClient): SharingApi {
  const rpc: Rpc = async (fn, args) => {
    const { data, error } = await client.rpc(fn, args)
    if (error) throw new Error(error.message)
    return data
  }
  const invites: InviteLister = async (tripId) => {
    const { data, error } = await client.from('trip_invites').select('id, expires_at, max_uses, used_count, revoked, created_at').eq('trip_id', tripId).order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data ?? []
  }
  return createSharingApi(rpc, invites)
}

// ───────── 이 기기의 멤버 목록 사본 ─────────
/** 서버의 멤버 목록으로 이 기기의 사본을 갱신한다. 서버가 접근을 막았으면(forbidden) 사본을 지우고 그 사실을 알린다. */
export async function refreshMembers(tripId: string, api: SharingApi, db: TripMateDB = defaultDb): Promise<'ok' | 'forbidden' | 'offline'> {
  let list: Member[]
  try { list = await api.listMembers(tripId) } catch (e) {
    const code = toSharingError(e).code
    if (code === 'forbidden') { await db.members.where('tripId').equals(tripId).delete(); return 'forbidden' }
    return 'offline'
  }
  const rows: MemberRow[] = list.map((m) => ({ id: `${tripId}:${m.userId}`, tripId, userId: m.userId, displayName: m.displayName, role: m.role, status: m.status, joinedAt: m.joinedAt, isMe: m.isMe }))
  await db.transaction('rw', db.members, async () => { await db.members.where('tripId').equals(tripId).delete(); await db.members.bulkPut(rows) })
  return 'ok'
}

/**
 * 내 권한(화면에서 버튼을 숨기기 위한 값. 실제 권한은 서버가 판단한다).
 *  1) 멤버 목록 사본에 내가 있으면 그 권한
 *  2) 서버와 연결된 적 없는 로컬 전용 여행(ownerId 'local')은 내가 만든 것이므로 관리자
 *  3) 서버 여행인데 사본이 아직 없으면: 내가 소유자일 때만 관리자, 아니면 가장 낮은 권한(동행자)으로 본다
 */
export async function myRole(tripId: string, db: TripMateDB = defaultDb, userId: string | null = null): Promise<Role> {
  const me = (await db.members.where('tripId').equals(tripId).toArray()).find((m) => m.isMe && m.status === 'active')
  if (me) return me.role
  const trip = await db.trips.get(tripId)
  if (!trip || trip.ownerId === 'local') return 'admin'
  return userId && trip.ownerId === userId ? 'admin' : 'member'
}
