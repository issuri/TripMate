import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { addExpense, deleteExpense, rateFromAmounts, recentDefaults, updateExpense } from '../db/expenses'
import { db } from '../db/local'
import type { Expense, ItemKind, Money, Trip } from '../db/types'
import { CATEGORY_HINT } from '../lib/budget'
import { buildMoney, defaultRateText, initialSplitMode } from '../lib/expenseForm'
import { CURRENCIES, currencyLabel, otherCurrencies } from '../lib/locales'
import { convertToHome, formatMinor, minorDigits, parseMajor, parseRateMicro } from '../lib/money'
import { nameOf, peopleFor } from '../lib/people'
import { rescaleSplits, splitEqual, validateSplits } from '../lib/split'
import { askConfirm, btnGhost, btnPrimary, Field, input, Sheet } from './kit'

export interface ExpensePreset { categoryHint?: ItemKind; categoryId?: string; itineraryItemId?: string | null; shoppingItemId?: string | null; localMinor?: number; currency?: string; memo?: string }

const toLocalInput = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16) }
const plain = (minor: number, cur: string) => formatMinor(minor, cur).replace(/,/g, '')

/**
 * 지출 등록/수정. 필수는 금액과 항목뿐이고 나머지는 최근 입력값으로 미리 채워 둔다.
 * 현지 통화 금액과 원화 환산 금액, 지출 당시 환율을 함께 저장한다. 환율이나 원화 금액을 직접 입력할 수 있다(인터넷 불필요).
 */
export default function ExpenseSheet({ trip, expense, preset, onClose }: { trip: Trip; expense?: Expense; preset?: ExpensePreset; onClose: () => void }) {
  const categories = (useLiveQuery(() => db.expenseCategories.where('tripId').equals(trip.id).filter((c) => !c.deletedAt).toArray(), [trip.id]) ?? []).sort((a, b) => a.sortOrder - b.sortOrder)
  const items = (useLiveQuery(() => db.itineraryItems.where('tripId').equals(trip.id).filter((i) => !i.deletedAt).toArray(), [trip.id]) ?? []).sort((a, b) => a.dayNumber - b.dayNumber || a.sortOrder - b.sortOrder)
  const people = useMemo(() => peopleFor(trip.companions), [trip.companions])
  const m0 = expense?.money
  const editing = !!expense
  const lockShared = !!expense && expense.money.shared && expense.version > 0   // 이미 서버에 올린 공동 경비는 개인 경비로 바꿀 수 없다

  const [local, setLocal] = useState(m0 ? plain(m0.localMinor, m0.currency) : preset?.localMinor ? plain(preset.localMinor, preset.currency ?? trip.localCurrency) : '')
  const [cur, setCur] = useState(m0?.currency ?? preset?.currency ?? trip.localCurrency)
  const [rate, setRate] = useState(m0 ? String(m0.rateMicro / 1e6) : defaultRateText(preset?.currency ?? trip.localCurrency))
  const dirty = useRef({ money: false, split: false })   // 사용자가 직접 바꾼 값만 다시 계산한다
  const [home, setHome] = useState(m0 ? String(m0.homeMinor) : '')
  const [last, setLast] = useState<'rate' | 'home'>('rate')
  const [categoryId, setCategoryId] = useState(expense?.categoryId ?? preset?.categoryId ?? '')
  const [paidAt, setPaidAt] = useState(toLocalInput(expense?.paidAt ?? Date.now()))
  const [method, setMethod] = useState(expense?.paymentMethod ?? '')
  const [memo, setMemo] = useState(expense?.memo ?? preset?.memo ?? '')
  const [itemId, setItemId] = useState(expense?.itineraryItemId ?? preset?.itineraryItemId ?? '')
  const [shared, setShared] = useState(m0?.shared ?? false)
  const [payer, setPayer] = useState(m0?.payer ?? 'self')
  const [picked, setPicked] = useState<string[]>(m0?.splits.map((s) => s.k) ?? [])
  const [mode, setModeRaw] = useState<'equal' | 'custom'>(() => (m0 ? initialSplitMode(m0, expense!.id) : 'equal'))
  const setMode = (v: 'equal' | 'custom') => { dirty.current.split = true; setModeRaw(v) }
  const [custom, setCustom] = useState<Record<string, string>>(() => Object.fromEntries((m0?.splits ?? []).map((s) => [s.k, String(s.s)])))
  const [err, setErr] = useState<string | null>(null)
  const [defaults, setDefaults] = useState<{ methods: string[]; rates: Record<string, number> } | null>(null)
  const busy = useRef(false)
  const seed = expense?.id ?? 'new-' + trip.id

  // 최근 입력값(항목·결제 수단·통화별 환율)을 기본값으로: 새 지출일 때만
  useEffect(() => {
    if (editing) return
    void recentDefaults(trip.id).then((d) => {
      setDefaults({ methods: d.methods, rates: d.rates })
      setMethod((v) => v || d.paymentMethod)
      if (!preset?.currency && d.currency) { setCur(d.currency); setRate(defaultRateText(d.currency, d.rates[d.currency])) }
      else if (d.rates[cur]) setRate(defaultRateText(cur, d.rates[cur]))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (categoryId || categories.length === 0 || editing) return
    void recentDefaults(trip.id).then((d) => {
      const hint = preset?.categoryHint ? categories.find((c) => c.name === CATEGORY_HINT[preset.categoryHint!]) : undefined
      setCategoryId(preset?.categoryId ?? hint?.id ?? (d.categoryId && categories.some((c) => c.id === d.categoryId) ? d.categoryId : categories[0].id))
    })
  }, [categories.length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (shared && picked.length === 0) setPicked(people.map((p) => p.key)) }, [shared]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 금액 계산: 환율을 입력하면 원화 금액을, 원화 금액을 입력하면 환율을 계산한다 ──
  const localMinor = parseMajor(local, cur)
  const isHomeCur = cur === 'KRW'
  const rateMicro = isHomeCur ? 1_000_000 : parseRateMicro(rate)
  const homeParsed = parseMajor(home, 'KRW')
  let homeMinor: number | null = null
  let effRate = rateMicro
  if (localMinor !== null && localMinor > 0) {
    if (isHomeCur) homeMinor = localMinor
    else if (last === 'home' && homeParsed !== null) { homeMinor = homeParsed; effRate = rateFromAmounts(localMinor, cur, homeParsed) }
    else if (rateMicro) homeMinor = convertToHome(localMinor, cur, rateMicro)
  }
  const shownHome = last === 'rate' || isHomeCur ? (homeMinor === null ? '' : String(homeMinor)) : home
  const shownRate = last === 'home' && !isHomeCur ? (effRate ? String(effRate / 1e6) : '') : rate

  // ── 분담 ──
  const participants = picked
  const toggle = (k: string) => { dirty.current.split = true; setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k])) }
  const splits = useMemo(() => {
    if (!shared || homeMinor === null || participants.length === 0) return []
    if (mode === 'equal') return splitEqual(homeMinor, participants, seed)
    return participants.map((k) => ({ k, s: parseMajor(custom[k] ?? '0', 'KRW') ?? 0 }))
  }, [shared, homeMinor, participants, mode, custom, seed])
  const splitErr = shared && homeMinor !== null ? validateSplits(homeMinor, splits) : null

  const switchToCustom = () => { setCustom(Object.fromEntries(splits.map((x) => [x.k, String(x.s)]))); setMode('custom') }
  // 금액을 바꾼 뒤 직접 정한 부담액의 합이 어긋나면 "금액에 맞춰 조정"으로 같은 비율로 다시 맞춘다
  const rescaleToNewAmount = () => { dirty.current.split = true; if (homeMinor !== null) setCustom(Object.fromEntries(rescaleSplits(homeMinor, participants.map((k) => ({ k, s: parseMajor(custom[k] ?? '0', 'KRW') ?? 0 })), seed).map((x) => [x.k, String(x.s)]))) }

  const save = async () => {
    if (busy.current) return
    const built = buildMoney({ local, cur, rate, home, last, shared, payer, picked, mode, custom, seed }, m0 ?? null, dirty.current)
    if (!built.ok) return setErr(built.error)
    if (!categoryId) return setErr('지출 항목을 선택하세요.')
    const money: Money = built.money
    busy.current = true
    try {
      const ms = new Date(paidAt).getTime()
      const common = { categoryId, paidAt: Number.isFinite(ms) ? ms : Date.now(), paymentMethod: method, itineraryItemId: itemId || null, memo, money }
      if (expense) await updateExpense(expense.id, common)
      else await addExpense(trip.id, { ...common, shoppingItemId: preset?.shoppingItemId ?? null })
      onClose()
    } catch (e) { setErr((e as Error).message); busy.current = false }
  }

  const extra = (expense?.money.splits ?? []).map((s) => s.k).filter((k) => !people.some((p) => p.key === k))   // 여행 정보에서 지운 동반자(기존 기록 유지용)
  const allKeys = [...people.map((p) => p.key), ...extra]

  return (
    <Sheet title={editing ? '지출 수정' : '지출 추가'} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2"><Field label="금액 *"><input autoFocus inputMode="decimal" className={`${input} text-xl font-bold`} value={local} onChange={(e) => { dirty.current.money = true; setLocal(e.target.value) }} placeholder="0" /></Field></div>
          <Field label="통화"><select className={input} value={cur} onChange={(e) => { dirty.current.money = true; setCur(e.target.value); setLast('rate'); setRate(defaultRateText(e.target.value, defaults?.rates[e.target.value])) }}>{[...new Set([...(m0 ? [m0.currency] : []), trip.localCurrency, ...CURRENCIES, ...otherCurrencies()])].map((c) => <option key={c} value={c}>{c}{currencyLabel(c) ? ` · ${currencyLabel(c)}` : ''}</option>)}</select></Field>
        </div>

        {!isHomeCur && (
          <div className="rounded-2xl bg-white p-3 ring-1 ring-line">
            <div className="grid grid-cols-2 gap-2">
              <Field label={`환율 (1 ${cur} = ? 원)`}><input inputMode="decimal" className={input} value={shownRate} onChange={(e) => { dirty.current.money = true; setRate(e.target.value); setLast('rate') }} placeholder="예: 9.1234" /></Field>
              <Field label="원화 금액(직접 입력 가능)"><input inputMode="numeric" className={input} value={shownHome} onChange={(e) => { dirty.current.money = true; setHome(e.target.value); setLast('home') }} /></Field>
            </div>
            <p className="mt-2 text-xs text-ink-3">환율은 직접 정할 수 있고, 지출 당시의 환율이 이 지출에 함께 저장돼요. 인터넷이 없어도 입력할 수 있어요.{homeMinor !== null && <> 지금 <b className="num">{homeMinor.toLocaleString('ko-KR')}원</b>으로 기록돼요.</>}</p>
          </div>
        )}

        <Field label="지출 항목 *">
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => <button key={c.id} type="button" onClick={() => setCategoryId(c.id)} className={`rounded-full px-4 py-2.5 text-sm font-semibold ${categoryId === c.id ? 'bg-ink text-white' : 'bg-white ring-1 ring-line'}`}>{c.name}</button>)}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="결제 날짜·시간"><input type="datetime-local" className={input} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} /></Field>
          <Field label="결제 수단">
            <input className={input} value={method} onChange={(e) => setMethod(e.target.value)} list="pay-methods" placeholder="현금, 카드…" />
            <datalist id="pay-methods">{[...(defaults?.methods ?? []), '현금', '카드', '교통카드', '간편결제'].filter((v, i, a) => a.indexOf(v) === i).map((m) => <option key={m} value={m} />)}</datalist>
          </Field>
        </div>

        <div className="rounded-2xl bg-white p-3 ring-1 ring-line">
          <label className="flex items-center justify-between gap-3">
            <span><span className="font-semibold">공동 경비</span><span className="block text-xs text-ink-2">{shared ? '함께 나눠 내는 지출이에요. 정산에 포함돼요.' : '나만 쓰는 개인 경비예요. 정산에 포함되지 않아요.'}</span></span>
            <input type="checkbox" className="h-6 w-6 accent-signal" checked={shared} disabled={lockShared} onChange={(e) => setShared(e.target.checked)} aria-label="공동 경비" />
          </label>
          {lockShared && <p className="mt-2 text-xs text-ink-3">이미 서버에 올린 공동 경비는 개인 경비로 바꿀 수 없어요. 삭제한 뒤 개인 경비로 다시 등록하세요.</p>}

          {shared && (
            <div className="mt-3 space-y-3">
              <Field label="결제한 사람"><select className={input} value={payer} onChange={(e) => setPayer(e.target.value)}>
                {[...new Set([payer, ...allKeys])].map((k) => <option key={k} value={k}>{nameOf(k, people)}</option>)}</select></Field>
              <div>
                <p className="mb-1.5 px-1 text-[13px] font-medium text-ink-2">함께 나눌 사람</p>
                <ul className="space-y-1.5">
                  {allKeys.map((k) => {
                    const on = picked.includes(k)
                    const isExtra = extra.includes(k)
                    const amount = splits.find((x) => x.k === k)?.s
                    return (
                      <li key={k} className="flex items-center gap-3 rounded-xl bg-paper px-3 py-2.5">
                        <input type="checkbox" className="h-5 w-5 accent-signal" checked={on} disabled={isExtra && !on} onChange={() => toggle(k)} aria-label={nameOf(k, people)} />
                        <span className="flex-1 text-sm">{nameOf(k, people)}</span>
                        {on && (mode === 'custom'
                          ? <input inputMode="numeric" aria-label={`${nameOf(k, people)} 부담 금액`} className="num w-32 rounded-lg border-0 bg-white px-2 py-1.5 text-right text-base ring-1 ring-line" value={custom[k] ?? ''} onChange={(e) => { dirty.current.split = true; setCustom({ ...custom, [k]: e.target.value }) }} />
                          : <span className="num text-sm text-ink-2">{amount !== undefined ? amount.toLocaleString('ko-KR') : '-'}원</span>)}
                      </li>
                    )
                  })}
                </ul>
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" className={`rounded-full px-3 py-1.5 text-xs font-semibold ${mode === 'equal' ? 'bg-signal-soft text-signal' : 'bg-paper'}`} onClick={() => setMode('equal')}>균등 분할</button>
                  <button type="button" className={`rounded-full px-3 py-1.5 text-xs font-semibold ${mode === 'custom' ? 'bg-signal-soft text-signal' : 'bg-paper'}`} onClick={switchToCustom}>금액 직접 입력</button>
                  {mode === 'custom' && <button type="button" className="rounded-full bg-paper px-3 py-1.5 text-xs font-semibold" onClick={rescaleToNewAmount}>금액에 맞춰 조정</button>}
                </div>
                {splitErr && homeMinor !== null && <p className="mt-2 text-xs text-danger" role="alert">{splitErr}</p>}
                {!splitErr && shared && homeMinor !== null && <p className="mt-2 text-xs text-mint">부담 금액의 합이 지출 금액과 같아요.</p>}
              </div>
            </div>
          )}
        </div>

        <Field label="연결할 일정 (선택)">
          <select className={input} value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">연결 안 함</option>{items.map((i) => <option key={i.id} value={i.id}>DAY {i.dayNumber} · {i.title}</option>)}</select>
        </Field>
        <Field label="메모"><input className={input} value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={1000} /></Field>

        {err && <p className="rounded-2xl bg-danger/10 p-3 text-sm text-danger" role="alert">{err}</p>}
        <div className="flex gap-2">
          {editing && <button className={`${btnGhost} text-danger`} onClick={async () => { if (await askConfirm('이 지출을 삭제할까요?\n예산과 정산 결과가 바뀌어요.', { confirmLabel: '삭제' })) { await deleteExpense(expense!.id); onClose() } }}>삭제</button>}
          <button className={`${btnPrimary} flex-1`} onClick={save}>저장</button>
        </div>
        {minorDigits(cur) > 0 && localMinor === null && local.trim() !== '' && <p className="text-xs text-danger">금액은 소수 {minorDigits(cur)}자리까지 입력할 수 있어요.</p>}
      </div>
    </Sheet>
  )
}
