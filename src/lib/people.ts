export interface Person { key: string; name: string; isMe: boolean }

/**
 * 경비에 나오는 "사람" 목록: '나'와 여행 정보에 적은 동반자 이름('n:이름').
 * 동반자는 계정 없이 이름만 적어 두고 N분의 1 정산에 쓴다.
 */
export function peopleFor(companions: string[]): Person[] {
  const seen = new Set<string>()
  const names = companions.map((c) => c.trim()).filter((c) => c && c !== '나' && !seen.has(c) && (seen.add(c), true))
  return [{ key: 'self', name: '나', isMe: true }, ...names.map((c) => ({ key: `n:${c.slice(0, 60)}`, name: c, isMe: false }))]
}

/** 키로 이름을 찾는다. 여행 정보에서 지운 동반자도 과거 기록에서는 이름으로 보여준다. */
export function nameOf(key: string, people: Person[]): string {
  const p = people.find((x) => x.key === key)
  if (p) return p.name
  if (key.startsWith('n:')) return key.slice(2)
  return '알 수 없는 사용자'
}
