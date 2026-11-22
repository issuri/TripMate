// 공동 경비 정산. 모든 금액은 원화 최소 단위 정수이므로 계산 결과가 정확히 0원으로 맞아떨어진다.
import type { Money } from '../db/types'

export interface Transfer { from: string; to: string; amount: number }

/** 공동 경비 하나가 만드는 순잔액: 결제자는 낸 만큼 받을 돈(+), 각 참여자는 자기 부담액만큼 낼 돈(-) */
export function balances(expenses: { money: Money }[]): Record<string, number> {
  const bal: Record<string, number> = {}
  for (const { money: m } of expenses) {
    if (!m.shared || !m.payer) continue
    bal[m.payer] = (bal[m.payer] ?? 0) + m.homeMinor
    for (const s of m.splits) bal[s.k] = (bal[s.k] ?? 0) - s.s
  }
  for (const k of Object.keys(bal)) if (bal[k] === 0) delete bal[k]
  return bal
}

/** 한 묶음(합이 0인 사람들)을 큰 채무자 ↔ 큰 채권자 순으로 맞춘다. 묶음 크기 k 에서 최대 k-1 번. */
function settleGroup(people: [string, number][]): Transfer[] {
  const debtors = people.filter(([, v]) => v < 0).map(([k, v]) => ({ k, v: -v })).sort((a, b) => b.v - a.v || a.k.localeCompare(b.k))
  const creditors = people.filter(([, v]) => v > 0).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v || a.k.localeCompare(b.k))
  const out: Transfer[] = []
  let i = 0, j = 0
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].v, creditors[j].v)
    out.push({ from: debtors[i].k, to: creditors[j].k, amount })
    debtors[i].v -= amount; creditors[j].v -= amount
    if (debtors[i].v === 0) i++
    if (creditors[j].v === 0) j++
  }
  return out
}

const EXACT_LIMIT = 16

/**
 * 송금 횟수가 최소가 되도록 정산한다.
 * 합이 0인 부분집합으로 최대한 많이 쪼갤수록 송금 횟수가 줄어든다(최소 횟수 = 인원 수 - 쪼갠 묶음 수).
 * 16명 이하는 모든 부분집합을 보는 정확한 방법, 그 이상은 한 묶음으로 보고 탐욕 방식으로 처리한다(최소가 아닐 수 있음).
 */
export function minTransfers(bal: Record<string, number>): Transfer[] {
  const people = Object.entries(bal).filter(([, v]) => v !== 0).sort(([a], [b]) => a.localeCompare(b))
  if (people.reduce((s, [, v]) => s + v, 0) !== 0) throw new Error('balances must sum to zero')
  const n = people.length
  if (n === 0) return []
  if (n > EXACT_LIMIT) return settleGroup(people)

  const size = 1 << n
  const sums = new Float64Array(size) // 금액은 안전 정수 범위 안이라 부분합도 정확하다
  for (let mask = 1; mask < size; mask++) {
    const low = 31 - Math.clz32(mask & -mask)
    sums[mask] = sums[mask & (mask - 1)] + people[low][1]
  }
  const dp = new Int16Array(size)         // dp[mask] = mask 안에서 만들 수 있는 합이 0인 묶음의 최대 개수
  const last = new Int8Array(size)        // 그 값을 만든 마지막 원소
  for (let mask = 1; mask < size; mask++) {
    let best = -1, bi = 0
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue
      const v = dp[mask ^ (1 << i)]
      if (v > best) { best = v; bi = i }
    }
    dp[mask] = best + (sums[mask] === 0 ? 1 : 0)
    last[mask] = bi
  }
  // 복원: 원소 순서를 되짚어서, 누적합이 0이 되는 지점마다 묶음을 끊는다
  const order: number[] = []
  for (let mask = size - 1; mask; mask ^= 1 << last[mask]) order.unshift(last[mask])
  const out: Transfer[] = []
  let group: [string, number][] = [], run = 0
  for (const i of order) {
    group.push(people[i]); run += people[i][1]
    if (run === 0) { out.push(...settleGroup(group)); group = [] }
  }
  return out
}

/** 정산 결과를 클립보드에 복사할 문장으로 */
export function formatSettlement(transfers: Transfer[], name: (k: string) => string, fmt: (n: number) => string): string {
  if (transfers.length === 0) return '정산할 금액이 없어요.'
  return transfers.map((t) => `${name(t.from)} → ${name(t.to)}  ${fmt(t.amount)}원`).join('\n')
}
