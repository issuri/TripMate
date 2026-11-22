// 지출 입력 폼의 금액·분담 계산(화면과 분리해서 테스트한다).
// 핵심 원칙: 사용자가 건드리지 않은 값은 절대 다시 계산하지 않는다. 다시 계산하면 반올림 때문에 저장된 금액이 슬쩍 바뀌거나,
// 직접 정한 부담액이 균등 분할로 덮어써진다.
import type { Money } from '../db/types'
import { rateFromAmounts } from '../db/expenses'
import { convertToHome, parseMajor, parseRateMicro } from './money'
import { rescaleSplits, splitEqual, validateSplits } from './split'

export interface FormState {
  local: string
  cur: string
  rate: string
  home: string
  last: 'rate' | 'home'          // 사용자가 마지막으로 만진 쪽(환율/원화 금액): 다른 쪽을 계산한다
  shared: boolean
  payer: string
  picked: string[]
  mode: 'equal' | 'custom'
  custom: Record<string, string>
  seed: string                   // 균등 분할에서 나머지 1원을 누가 갖는지 정하는 값(지출 id)
}

export interface Dirty { money: boolean; split: boolean }
export type Built = { ok: true; money: Money } | { ok: false; error: string }

/** 입력값으로 계산한 현지 금액·환율·원화 금액. 계산할 수 없으면 null. */
export function computeAmounts(f: Pick<FormState, 'local' | 'cur' | 'rate' | 'home' | 'last'>) {
  const localMinor = parseMajor(f.local, f.cur)
  if (localMinor === null || localMinor <= 0) return { localMinor: null, rateMicro: null as number | null, homeMinor: null as number | null }
  if (f.cur === 'KRW') return { localMinor, rateMicro: 1_000_000, homeMinor: localMinor }
  const homeParsed = parseMajor(f.home, 'KRW')
  if (f.last === 'home' && homeParsed !== null) return { localMinor, rateMicro: rateFromAmounts(localMinor, f.cur, homeParsed), homeMinor: homeParsed }
  const rate = parseRateMicro(f.rate)
  return { localMinor, rateMicro: rate, homeMinor: rate ? convertToHome(localMinor, f.cur, rate) : null }
}

/** 수정 화면에서 처음 보여줄 분할 방식: 저장된 분담이 균등 분할 결과와 같으면 균등, 아니면 직접 입력 */
export function initialSplitMode(m: Money, seed: string): 'equal' | 'custom' {
  if (!m.shared || m.splits.length === 0) return 'equal'
  const eq = splitEqual(m.homeMinor, m.splits.map((x) => x.k), seed)
  const same = m.splits.every((x) => eq.find((e) => e.k === x.k)?.s === x.s)
  return same ? 'equal' : 'custom'
}

export function buildMoney(f: FormState, original: Money | null, dirty: Dirty): Built {
  // 수정 화면에서 아무것도 안 바꿨다면 저장된 값을 그대로 쓴다
  if (original && !dirty.money && !dirty.split && f.shared === original.shared && (f.shared ? f.payer === original.payer : true)) return { ok: true, money: original }

  const a = original && !dirty.money ? { localMinor: original.localMinor, rateMicro: original.rateMicro, homeMinor: original.homeMinor } : computeAmounts(f)
  const cur = original && !dirty.money ? original.currency : f.cur
  if (a.localMinor === null || a.localMinor <= 0) return { ok: false, error: '금액을 입력하세요.' }
  if (!a.rateMicro) return { ok: false, error: '환율을 입력하세요. 예: 9.1234' }
  if (a.homeMinor === null) return { ok: false, error: '원화 금액을 계산할 수 없어요. 금액과 환율을 확인하세요.' }

  if (!f.shared) return { ok: true, money: { localMinor: a.localMinor, currency: cur, rateMicro: a.rateMicro, homeMinor: a.homeMinor, shared: false, payer: original?.payer ?? 'self', splits: [] } }

  let splits: { k: string; s: number }[]
  if (original?.shared && !dirty.split) splits = rescaleSplits(a.homeMinor, original.splits, f.seed)          // 금액만 바뀌었으면 기존 비율 유지
  else if (f.mode === 'equal') splits = f.picked.length ? splitEqual(a.homeMinor, f.picked, f.seed) : []
  else splits = f.picked.map((k) => ({ k, s: parseMajor(f.custom[k] ?? '0', 'KRW') ?? 0 }))
  const err = validateSplits(a.homeMinor, splits)
  if (err) return { ok: false, error: err }
  return { ok: true, money: { localMinor: a.localMinor, currency: cur, rateMicro: a.rateMicro, homeMinor: a.homeMinor, shared: true, payer: f.payer, splits } }
}

/** 환율 입력칸의 기본값: 원화는 1, 외화는 최근 환율이 있을 때만(없으면 비워서 직접 입력하게 한다. 1로 두면 1,500엔이 1,500원으로 기록된다) */
export function defaultRateText(cur: string, recentMicro?: number): string {
  if (cur === 'KRW') return '1'
  return recentMicro ? String(recentMicro / 1e6) : ''
}
