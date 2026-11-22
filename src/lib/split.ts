import type { Money } from '../db/types'

/** 같은 id 는 항상 같은 값이 나오는 간단한 해시(FNV-1a). 서로 다른 기기에서도 같은 결과가 필요해서 난수 대신 쓴다. */
export function hashId(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

/**
 * 균등 분할. 나누어떨어지지 않는 나머지(원 단위)는 1원씩 나눠 갖는다.
 * 나머지를 받는 사람은 지출 id 에서 정해서, 항상 같은 사람이 손해 보지 않게 한다. 합계는 항상 total 과 정확히 같다.
 */
export function splitEqual(total: number, keys: string[], seed: string): { k: string; s: number }[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('total must be a non-negative integer')
  const uniq = [...new Set(keys)]
  if (uniq.length === 0) throw new Error('at least one participant is required')
  const n = uniq.length
  const base = Math.floor(total / n)
  const rest = total - base * n
  const start = hashId(seed) % n
  return uniq.map((k, i) => ({ k, s: base + (((i - start + n) % n) < rest ? 1 : 0) }))
}

/** 분담이 올바른지: 참여자가 있고, 중복이 없고, 각 금액이 0 이상 정수이며, 합계가 원화 금액과 같다. 문제가 없으면 null. */
export function validateSplits(homeMinor: number, splits: { k: string; s: number }[]): string | null {
  if (splits.length === 0) return '참여자를 한 명 이상 선택하세요.'
  if (new Set(splits.map((x) => x.k)).size !== splits.length) return '같은 참여자가 두 번 들어 있어요.'
  if (splits.some((x) => !Number.isSafeInteger(x.s) || x.s < 0)) return '부담 금액이 올바르지 않아요.'
  const total = splits.reduce((a, x) => a + x.s, 0)
  if (total !== homeMinor) return `부담 금액의 합(${total.toLocaleString('ko-KR')})이 지출 금액(${homeMinor.toLocaleString('ko-KR')})과 달라요. ${total > homeMinor ? `${(total - homeMinor).toLocaleString('ko-KR')}원 초과` : `${(homeMinor - total).toLocaleString('ko-KR')}원 부족`}`
  return null
}

/** 지출 금액이 바뀌면 사용자가 직접 정한 부담액 비율을 유지하며 새 금액에 맞춘다(합계는 항상 정확히 일치). */
export function rescaleSplits(newTotal: number, splits: { k: string; s: number }[], seed: string): { k: string; s: number }[] {
  const old = splits.reduce((a, x) => a + x.s, 0)
  if (old === 0) return splitEqual(newTotal, splits.map((x) => x.k), seed)
  let assigned = 0
  // 곱셈이 안전 정수 범위를 넘을 수 있어 BigInt 로 계산한다
  const out = splits.map((x) => { const s = Number((BigInt(newTotal) * BigInt(x.s)) / BigInt(old)); assigned += s; return { k: x.k, s } })
  let rest = newTotal - assigned
  for (let i = 0; rest > 0; i = (i + 1) % out.length) { if (splits[i].s > 0) { out[i].s += 1; rest -= 1 } }
  return out
}

export const isSharedWithSplits = (m: Money) => m.shared && m.splits.length > 0
