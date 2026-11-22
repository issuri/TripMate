import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import { addCategory, deleteCategory, listExpenses, updateCategory } from '../db/expenses'
import { updateTrip } from '../db/itinerary'
import { db } from '../db/local'
import type { Expense, Trip } from '../db/types'
import { computeStatus } from '../lib/dates'
import { dateIn, summarizeBudget } from '../lib/budget'
import { formatMinor, parseMajor } from '../lib/money'
import { nameOf, peopleFor } from '../lib/people'
import { balances, formatSettlement, minTransfers } from '../lib/settle'
import ExpenseSheet from './ExpenseSheet'
import { btnGhost, btnPrimary, Card, Field, input, Sheet } from './kit'

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`
type Tab = 'list' | 'category' | 'settle'

export default function ExpensesPage() {
  const trip = useOutletContext<Trip>()
  const [sp, setSp] = useSearchParams()
  const [tab, setTab] = useState<Tab>('list')
  const [editing, setEditing] = useState<Expense | 'new' | null>(sp.get('add') ? 'new' : null)
  const [budgetEdit, setBudgetEdit] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { if (sp.get('add')) setSp((p) => { p.delete('add'); return p }, { replace: true }) }, [sp, setSp])

  const expenses = useLiveQuery(() => listExpenses(trip.id), [trip.id]) ?? []
  const categories = useLiveQuery(() => db.expenseCategories.where('tripId').equals(trip.id).toArray(), [trip.id]) ?? []
  const items = useLiveQuery(() => db.itineraryItems.where('tripId').equals(trip.id).toArray(), [trip.id]) ?? []
  const people = useMemo(() => peopleFor(trip.companions), [trip.companions])
  const sum = useMemo(() => summarizeBudget({ totalBudgetMinor: trip.totalBudgetMinor, categories, expenses: expenses.length ? expenses : [], timeZone: trip.timeZone }), [trip.totalBudgetMinor, categories, expenses, trip.timeZone])
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? '삭제된 항목'
  const itemTitle = (id: string | null) => items.find((i) => i.id === id)?.title

  const saveBudget = async () => {
    const raw = (budgetEdit ?? '').trim()
    const v = raw === '' ? 0 : parseMajor(raw, 'KRW')
    if (v === null) return setMsg('예산은 숫자로 입력하세요. 예: 1,500,000')
    try { await updateTrip(trip.id, { totalBudgetMinor: v }); setBudgetEdit(null); setMsg(null) } catch (e) { setMsg((e as Error).message) }
  }

  const byDay = useMemo(() => {
    const g = new Map<string, Expense[]>()
    for (const e of expenses) { const d = dateIn(e.paidAt, trip.timeZone); g.set(d, [...(g.get(d) ?? []), e]) }
    return [...g].sort(([a], [b]) => b.localeCompare(a))
  }, [expenses, trip.timeZone])

  const finished = computeStatus(trip.startDate, trip.endDate, trip.timeZone) === 'finished'
  const pct = sum.usedPct === null ? 0 : Math.min(100, sum.usedPct)

  return (
    <div className="space-y-4 pb-24">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-ink-2">{finished ? '여행 전체 경비' : '총 지출'}</p>
            <p className="num text-3xl font-extrabold">{won(sum.spentMinor)}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-ink-2">전체 예산</p>
            {budgetEdit === null
              ? <button className="num text-lg font-bold" onClick={() => setBudgetEdit(trip.totalBudgetMinor ? String(trip.totalBudgetMinor) : '')}>{trip.totalBudgetMinor ? won(trip.totalBudgetMinor) : '설정하기'}</button>
              : <div className="mt-1 flex gap-1"><input autoFocus inputMode="numeric" aria-label="전체 예산" className="num w-32 rounded-xl border-0 bg-paper px-3 py-2 text-right ring-1 ring-line" value={budgetEdit} onChange={(e) => setBudgetEdit(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveBudget()} /><button className="rounded-xl bg-ink px-3 text-sm font-semibold text-white" onClick={saveBudget}>저장</button></div>}
          </div>
        </div>
        {trip.totalBudgetMinor > 0 && (
          <>
            <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-line"><div className={`h-full rounded-full ${sum.overBudget ? 'bg-danger' : 'bg-mint'}`} style={{ width: `${pct}%` }} /></div>
            <p className={`num mt-2 text-sm ${sum.overBudget ? 'font-bold text-danger' : 'text-ink-2'}`} role={sum.overBudget ? 'alert' : undefined}>
              {sum.overBudget ? `예산을 ${won(sum.overByMinor)} 초과했어요` : `남은 예산 ${won(sum.remainingMinor)}`} · 사용률 {sum.usedPct}%
            </p>
          </>
        )}
        <dl className="num mt-3 grid grid-cols-3 gap-2 text-sm">
          <div><dt className="text-xs text-ink-2">오늘 지출</dt><dd className="font-bold">{won(sum.todayMinor)}</dd></div>
          <div><dt className="text-xs text-ink-2">공동 경비</dt><dd className="font-bold">{won(sum.sharedMinor)}</dd></div>
          <div><dt className="text-xs text-ink-2">가장 많은 항목</dt><dd className="truncate font-bold">{sum.topCategory ? sum.topCategory.name : '-'}</dd></div>
        </dl>
        {msg && <p className="mt-2 text-xs text-danger" role="alert">{msg}</p>}
      </Card>

      <div className="flex gap-1 rounded-full bg-white p-1 ring-1 ring-line" role="tablist">
        {([['list', '내역'], ['category', '항목별'], ['settle', '정산']] as [Tab, string][]).map(([t, l]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`flex-1 rounded-full py-2.5 text-sm font-semibold ${tab === t ? 'bg-ink text-white' : 'text-ink-2'}`} onClick={() => setTab(t)}>{l}</button>
        ))}
      </div>

      {tab === 'list' && (
        expenses.length === 0
          ? <div className="rounded-[1.25rem] border-2 border-dashed border-line p-8 text-center"><p className="font-semibold">아직 지출이 없어요</p><p className="mt-1 text-sm text-ink-2">금액과 항목만 입력하면 바로 기록할 수 있어요.</p></div>
          : <div className="space-y-4">
              {byDay.map(([date, list]) => (
                <section key={date}>
                  <div className="num mb-1.5 flex items-baseline justify-between px-1 text-sm"><span className="font-bold">{date.slice(5).replace('-', '.')}</span><span className="text-ink-2">{won(list.reduce((a, e) => a + e.money.homeMinor, 0))}</span></div>
                  <Card className="divide-y divide-line !p-0">
                    {list.map((e) => (
                      <button key={e.id} className="flex w-full items-center gap-3 px-4 py-3.5 text-left" onClick={() => setEditing(e)}>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold">{catName(e.categoryId)}{e.memo && <span className="font-normal text-ink-2"> · {e.memo}</span>}</p>
                          <p className="truncate text-xs text-ink-2">
                            <span className={`mr-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold ${e.money.shared ? 'bg-signal-soft text-signal' : 'bg-line text-ink-2'}`}>{e.money.shared ? '공동' : '개인'}</span>
                            {e.money.payer ? `${nameOf(e.money.payer, people)} 결제` : ''}{e.paymentMethod && ` · ${e.paymentMethod}`}{itemTitle(e.itineraryItemId) && ` · ${itemTitle(e.itineraryItemId)}`}
                          </p>
                        </div>
                        <div className="num text-right">
                          <p className="font-bold">{won(e.money.homeMinor)}</p>
                          {e.money.currency !== 'KRW' && <p className="text-xs text-ink-2">{formatMinor(e.money.localMinor, e.money.currency)} {e.money.currency}</p>}
                        </div>
                      </button>
                    ))}
                  </Card>
                </section>
              ))}
            </div>
      )}

      {tab === 'category' && <CategoryTab trip={trip} rows={sum.byCategory} total={sum.spentMinor} />}
      {tab === 'settle' && <SettleTab trip={trip} expenses={expenses} people={people} finished={finished} />}

      <div className="pointer-events-none fixed inset-x-4 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-10 mx-auto max-w-md">
        <button className={`${btnPrimary} pointer-events-auto w-full shadow-[0_8px_24px_rgba(15,20,36,.25)]`} onClick={() => setEditing('new')}>지출 추가</button>
      </div>
      {editing && <ExpenseSheet trip={trip} expense={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function CategoryTab({ trip, rows, total }: { trip: Trip; rows: ReturnType<typeof summarizeBudget>['byCategory']; total: number }) {
  const [edit, setEdit] = useState<{ id: string | null; name: string; budget: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const save = async () => {
    if (!edit) return
    const b = edit.budget.trim() === '' ? 0 : parseMajor(edit.budget, 'KRW')
    if (b === null) return setErr('예산은 숫자로 입력하세요.')
    try { if (edit.id) await updateCategory(edit.id, { name: edit.name, budgetMinor: b }); else await addCategory(trip.id, edit.name, b); setEdit(null); setErr(null) } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="space-y-3">
      <Card className="divide-y divide-line !p-0">
        {rows.map((c) => (
          <button key={c.id} disabled={c.id === '_deleted'} className="block w-full px-4 py-3.5 text-left" onClick={() => setEdit({ id: c.id, name: c.name, budget: c.budgetMinor ? String(c.budgetMinor) : '' })}>
            <div className="flex items-baseline justify-between"><span className="font-semibold">{c.name}</span><span className="num font-bold">{won(c.spentMinor)}</span></div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line"><div className={`h-full rounded-full ${c.over ? 'bg-danger' : 'bg-signal'}`} style={{ width: `${c.budgetMinor > 0 ? Math.min(100, (c.spentMinor / c.budgetMinor) * 100) : total > 0 ? (c.spentMinor / total) * 100 : 0}%` }} /></div>
            <p className={`num mt-1 text-xs ${c.over ? 'font-semibold text-danger' : 'text-ink-2'}`}>{c.budgetMinor > 0 ? `예산 ${won(c.budgetMinor)} · ${c.pct}%${c.over ? ' · 초과' : ''}` : '예산 없음'}</p>
          </button>
        ))}
      </Card>
      <button className={`${btnGhost} w-full`} onClick={() => setEdit({ id: null, name: '', budget: '' })}>항목 추가</button>
      {edit && (
        <Sheet title={edit.id ? '항목 수정' : '항목 추가'} onClose={() => { setEdit(null); setErr(null) }}>
          <div className="space-y-3">
            <Field label="이름"><input autoFocus className={input} value={edit.name} maxLength={40} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="항목 예산 (원, 비우면 예산 없음)"><input inputMode="numeric" className={input} value={edit.budget} onChange={(e) => setEdit({ ...edit, budget: e.target.value })} /></Field>
            {err && <p className="rounded-2xl bg-danger/10 p-3 text-sm text-danger" role="alert">{err}</p>}
            <div className="flex gap-2">
              {edit.id && <button className={`${btnGhost} text-danger`} onClick={async () => { try { await deleteCategory(edit.id!); setEdit(null); setErr(null) } catch (e) { setErr((e as Error).message) } }}>삭제</button>}
              <button className={`${btnPrimary} flex-1`} onClick={save}>저장</button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  )
}

function SettleTab({ expenses, people, finished }: { trip: Trip; expenses: Expense[]; people: ReturnType<typeof peopleFor>; finished: boolean }) {
  const [copied, setCopied] = useState(false)

  const shared = expenses.filter((e) => e.money.shared)
  const bal = useMemo(() => balances(shared), [shared])
  const transfers = useMemo(() => minTransfers(bal), [bal])
  const ready = true       // 동반자는 이름만 적어 두므로, 이 기기의 기록만으로 바로 정산할 수 있다
  const name = (k: string) => nameOf(k, people)
  const text = formatSettlement(transfers, name, (n) => n.toLocaleString('ko-KR'))

  const paid = (k: string) => shared.filter((e) => e.money.payer === k).reduce((a, e) => a + e.money.homeMinor, 0)
  const owed = (k: string) => shared.reduce((a, e) => a + (e.money.splits.find((x) => x.k === k)?.s ?? 0), 0)
  const keys = [...new Set([...people.map((p) => p.key), ...Object.keys(bal)])]

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">{finished && ready ? '최종 정산 결과' : '현재까지의 정산'}</h2>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${ready ? 'bg-mint/15 text-mint' : 'bg-coral/15 text-coral'}`}>{ready ? (finished ? '최종' : '중간') : '임시'}</span>
        </div>
        {shared.length === 0 && <p className="mt-3 text-sm text-ink-2">공동 경비가 없어요. 지출을 등록할 때 "공동 경비"를 켜면 여기서 정산해요.</p>}
        {shared.length > 0 && (
          <>
            <ul className="mt-3 divide-y divide-line">
              {keys.map((k) => {
                const net = (bal[k] ?? 0)
                return (
                  <li key={k} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1"><p className="truncate font-semibold">{name(k)}</p><p className="num text-xs text-ink-2">낸 돈 {won(paid(k))} · 내 몫 {won(owed(k))}</p></div>
                    <p className={`num font-bold ${net > 0 ? 'text-mint' : net < 0 ? 'text-danger' : 'text-ink-2'}`}>{net > 0 ? `+${won(net)} 받기` : net < 0 ? `${won(-net)} 보내기` : '정산 완료'}</p>
                  </li>
                )
              })}
            </ul>
            <h3 className="mt-3 text-sm font-bold">누가 누구에게 보내면 될까요 {transfers.length > 0 && <span className="font-normal text-ink-2">· 총 {transfers.length}번</span>}</h3>
            {transfers.length === 0
              ? <p className="mt-2 text-sm text-ink-2">정산할 금액이 없어요.</p>
              : <ul className="mt-2 space-y-2">{transfers.map((t, i) => <li key={i} className="num rounded-2xl bg-paper p-3 text-sm"><b>{name(t.from)}</b> → <b>{name(t.to)}</b> <span className="float-right font-bold">{won(t.amount)}</span></li>)}</ul>}
            <button className={`${btnPrimary} mt-3 w-full`} disabled={transfers.length === 0 || !ready} onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* 클립보드를 못 쓰는 환경 */ } }}>{copied ? '복사했어요' : '정산 결과 복사'}</button>
            {!ready && transfers.length > 0 && <p className="mt-2 text-xs text-ink-3">동기화가 끝나면 복사할 수 있어요. 송금은 앱에서 처리하지 않아요. 결과를 보고 직접 보내세요.</p>}
            {ready && <p className="mt-2 text-xs text-ink-3">송금이나 결제 기능은 없어요. 복사한 결과를 보고 직접 보내세요. 원 단위까지 정확하게 계산했어요.</p>}
          </>
        )}
      </Card>
    </div>
  )
}
