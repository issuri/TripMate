import type { MemberRow } from '../db/types'

export interface Person { key: string; name: string; isMe: boolean; account: boolean }

/**
 * 경비에 나오는 "사람" 목록.
 *  - 서버와 공유 중인 여행(참여 중인 멤버가 있음): 멤버. 나는 'self', 다른 멤버는 사용자 UUID
 *  - 로컬 전용 여행: '나'와 여행 정보에 적은 동반자 이름('n:이름'). 계정이 없어도 정산할 수 있다.
 */
export function peopleFor(companions: string[], members: MemberRow[]): Person[] {
  const active = members.filter((m) => m.status === 'active')
  if (active.length > 0) {
    return active.sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.joinedAt - b.joinedAt)
      .map((m) => ({ key: m.isMe ? 'self' : m.userId, name: m.isMe ? '나' : m.displayName || '(이름 없음)', isMe: m.isMe, account: true }))
  }
  const seen = new Set<string>()
  const names = companions.map((c) => c.trim()).filter((c) => c && c !== '나' && !seen.has(c) && (seen.add(c), true))
  return [{ key: 'self', name: '나', isMe: true, account: false }, ...names.map((c) => ({ key: `n:${c.slice(0, 60)}`, name: c, isMe: false, account: false }))]
}

/** 키로 이름을 찾는다. 내보내졌거나 나간 멤버, 삭제된 동반자도 과거 기록에서는 이름으로 보여준다. */
export function nameOf(key: string, people: Person[], members: MemberRow[] = []): string {
  const p = people.find((x) => x.key === key)
  if (p) return p.name
  if (key.startsWith('n:')) return key.slice(2)
  const m = members.find((x) => x.userId === key)
  if (m) return `${m.displayName || '(이름 없음)'}${m.status === 'active' ? '' : m.status === 'left' ? ' (나감)' : ' (내보냄)'}`
  return '알 수 없는 사용자'
}
