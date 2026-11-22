import { useLiveQuery } from 'dexie-react-hooks'
import { useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { updateTrip } from '../db/itinerary'
import { db } from '../db/local'
import { addShopping, deleteShopping, setPurchased, updateShopping } from '../db/shopping'
import type { ShoppingItem, Trip } from '../db/types'
import { formatMinor, parseMajor } from '../lib/money'
import { placeUrl } from '../lib/maps'
import { listExpenses } from '../db/expenses'
import { changedFields } from '../lib/diff'
import ExpenseSheet from './ExpenseSheet'
import { summarizeShopping } from '../lib/shopping'
import { btnGhost, btnPrimary, Card, Field, input, Sheet } from './kit'

export default function ShoppingPage() {
  const trip = useOutletContext<Trip>()
  const cur = trip.localCurrency
  const items = useLiveQuery(() => db.shoppingItems.where('tripId').equals(trip.id).filter((s) => !s.deletedAt).toArray(), [trip.id]) ?? []
  const places = useLiveQuery(() => db.places.where('tripId').equals(trip.id).filter((p) => !p.deletedAt).toArray(), [trip.id]) ?? []
  const itinerary = useLiveQuery(() => db.itineraryItems.where('tripId').equals(trip.id).filter((i) => !i.deletedAt).toArray(), [trip.id]) ?? []
  const expenses = useLiveQuery(() => listExpenses(trip.id), [trip.id]) ?? []
  const recorded = new Set(expenses.map((e) => e.shoppingItemId).filter((x): x is string => !!x))
  const [recordFor, setRecordFor] = useState<ShoppingItem | null>(null)
  const [editing, setEditing] = useState<ShoppingItem | 'new' | null>(null)
  const [paying, setPaying] = useState<ShoppingItem | null>(null)
  const [budgetEdit, setBudgetEdit] = useState<string | null>(null)
  const [budgetErr, setBudgetErr] = useState<string | null>(null)

  const sum = summarizeShopping(items, trip.shoppingBudgetMinor)
  const pct = sum.budgetMinor ? Math.min(100, Math.round((sum.actualMinor / sum.budgetMinor) * 100)) : 0
  const f = (n: number) => `${formatMinor(n, cur)} ${cur}`
  const placeOf = (id: string | null) => places.find((p) => p.id === id)

  // 매장별 그룹
  const groups = new Map<string, ShoppingItem[]>()
  for (const s of items) groups.set(s.storePlaceId ?? '', [...(groups.get(s.storePlaceId ?? '') ?? []), s])
  const order = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : (placeOf(a)?.name ?? '').localeCompare(placeOf(b)?.name ?? '')))

  const saveBudget = async () => {
    const raw = (budgetEdit ?? '').trim()
    const v = raw === '' ? 0 : parseMajor(raw, cur) // 비우면 예산 해제
    if (v === null) { setBudgetErr('금액을 숫자로 입력하세요. 예: 50000 또는 50,000'); return } // 조용히 닫히면 저장된 것으로 오해한다
    try { await updateTrip(trip.id, { shoppingBudgetMinor: v }); setBudgetErr(null); setBudgetEdit(null) } catch (e) { setBudgetErr((e as Error).message) }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-ink-2">쇼핑 예산</p>
            {budgetEdit === null
              ? <button className="num text-left text-2xl font-extrabold" onClick={() => setBudgetEdit(trip.shoppingBudgetMinor ? formatMinor(trip.shoppingBudgetMinor, cur).replace(/,/g, '') : '')}>{sum.budgetMinor ? f(sum.budgetMinor) : '예산 설정'}</button>
              : <div className="mt-1 flex gap-2"><input autoFocus inputMode="decimal" className={input} value={budgetEdit} onChange={(e) => setBudgetEdit(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveBudget()} /><button className={btnPrimary} onClick={saveBudget}>저장</button></div>}
          </div>
          {budgetErr && <p className="mt-1 text-xs text-danger" role="alert">{budgetErr}</p>}
          {sum.overBudget && <span className="rounded-full bg-danger/10 px-3 py-1 text-xs font-bold text-danger">예산 초과 예상</span>}
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-line"><div className={`h-full rounded-full ${sum.overBudget ? 'bg-danger' : 'bg-mint'}`} style={{ width: `${pct}%` }} /></div>
        <dl className="num mt-3 grid grid-cols-3 gap-2 text-sm">
          <div><dt className="text-xs text-ink-2">예상 합계</dt><dd className="font-bold">{formatMinor(sum.expectedMinor, cur)}</dd></div>
          <div><dt className="text-xs text-ink-2">실제 결제</dt><dd className="font-bold">{formatMinor(sum.actualMinor, cur)}</dd></div>
          <div><dt className="text-xs text-ink-2">구매 완료</dt><dd className="font-bold">{sum.purchasedCount}/{items.length}</dd></div>
        </dl>
        <p className="mt-2 text-xs text-ink-3">금액은 현지 통화({cur}) 기준이에요. 예상 가격은 지출로 자동 기록되지 않아요.</p>
        {sum.unpricedPurchased > 0 && <p className="mt-1 text-xs text-coral">실제 결제 금액을 입력하지 않은 구매 완료 상품이 {sum.unpricedPurchased}개 있어요.</p>}
      </Card>

      {items.length === 0 && <div className="rounded-[1.25rem] border-2 border-dashed border-line p-8 text-center"><p className="font-semibold">쇼핑 리스트가 비어 있어요</p><p className="mt-1 text-sm text-ink-2">사고 싶은 상품과 매장을 추가해 보세요.</p></div>}

      {order.map((k) => {
        const p = placeOf(k || null)
        return (
          <Card key={k || 'none'} className="!p-0">
            <div className="flex items-center justify-between px-4 pt-4">
              <h2 className="font-bold">{p ? p.name : '매장 미정'}</h2>
              {p && <a href={placeUrl(p)} target="_blank" rel="noreferrer" className="text-xs font-semibold text-signal">지도</a>}
            </div>
            <ul className="divide-y divide-line">
              {groups.get(k)!.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3.5">
                  <input type="checkbox" className="check" checked={s.purchased} aria-label={`${s.name} 구매 완료`}
                    onChange={(e) => (e.target.checked ? setPaying(s) : setPurchased(s.id, false))} />
                  <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(s)}>
                    <p className={`font-semibold ${s.purchased ? 'text-ink-3 line-through' : ''}`}>{s.name} <span className="num font-normal text-ink-2">×{s.quantity}</span></p>
                    <p className="num text-xs text-ink-2">
                      예상 {formatMinor(s.expectedPriceMinor * s.quantity, cur)}{s.purchased && <> · 실제 {s.actualPriceMinor != null ? formatMinor(s.actualPriceMinor, cur) : '미입력'}</>}
                      {s.memo && ` · ${s.memo}`}
                    </p>
                  </button>
                  {/* 구매 완료 + 실제 결제 금액이 있으면 사용자가 확인한 뒤 지출로 기록한다(예상 가격은 절대 자동으로 지출이 되지 않는다) */}
                  {s.purchased && s.actualPriceMinor != null && (recorded.has(s.id)
                    ? <span className="shrink-0 rounded-full bg-mint/15 px-2.5 py-1 text-[11px] font-bold text-mint">지출 기록됨</span>
                    : <button className="shrink-0 rounded-full bg-signal-soft px-3 py-2 text-xs font-semibold text-signal" onClick={() => setRecordFor(s)}>지출로 기록</button>)}
                </li>
              ))}
            </ul>
          </Card>
        )
      })}

      <button className={`${btnPrimary} w-full`} onClick={() => setEditing('new')}>상품 추가</button>

      {paying && <PaySheet item={paying} cur={cur} onClose={() => setPaying(null)} />}
      {recordFor && <ExpenseSheet trip={trip} preset={{ shoppingItemId: recordFor.id, categoryHint: 'shopping', localMinor: recordFor.actualPriceMinor ?? undefined, currency: recordFor.currency, memo: recordFor.name }} onClose={() => setRecordFor(null)} />}
      {editing && <ItemSheet trip={trip} item={editing === 'new' ? null : editing} places={places} itinerary={itinerary} onClose={() => setEditing(null)} />}
    </div>
  )
}

function PaySheet({ item, cur, onClose }: { item: ShoppingItem; cur: string; onClose: () => void }) {
  const [v, setV] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const busy = useRef(false)
  const done = async (withPrice: boolean) => {
    if (busy.current) return
    if (withPrice) {
      const m = parseMajor(v, cur)
      if (m === null) return setErr('금액을 숫자로 입력하세요.')
      busy.current = true
      await setPurchased(item.id, true, m)
    } else { busy.current = true; await setPurchased(item.id, true) }
    onClose()
  }
  return (
    <Sheet title="구매 완료" onClose={onClose}>
      <p className="mb-3 text-sm text-ink-2">"{item.name}"의 실제 결제 금액을 확인했다면 입력하세요. 예상 가격({formatMinor(item.expectedPriceMinor * item.quantity, cur)} {cur})은 자동으로 쓰이지 않아요.</p>
      <Field label={`실제 결제 금액 (${cur})`}><input autoFocus inputMode="decimal" className={input} value={v} onChange={(e) => setV(e.target.value)} /></Field>
      {err && <p className="mt-2 text-sm text-danger" role="alert">{err}</p>}
      <div className="mt-4 flex gap-2">
        <button className={`${btnGhost} flex-1`} onClick={() => done(false)}>금액은 나중에</button>
        <button className={`${btnPrimary} flex-1`} onClick={() => done(true)}>완료</button>
      </div>
    </Sheet>
  )
}

function ItemSheet({ trip, item, places, itinerary, onClose }: { trip: Trip; item: ShoppingItem | null; places: { id: string; name: string }[]; itinerary: { id: string; title: string; dayNumber: number }[]; onClose: () => void }) {
  const cur = trip.localCurrency
  const [f, setF] = useState({
    name: item?.name ?? '', quantity: String(item?.quantity ?? 1), price: item ? formatMinor(item.expectedPriceMinor, cur).replace(/,/g, '') : '',
    store: item?.storePlaceId ?? '', link: item?.itineraryItemId ?? '', memo: item?.memo ?? '',
  })
  const [err, setErr] = useState<string | null>(null)
  const busy = useRef(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const save = async () => {
    const price = f.price === '' ? 0 : parseMajor(f.price, cur)
    if (price === null) return setErr('가격을 올바르게 입력하세요.')
    const data = { name: f.name, quantity: Number(f.quantity), expectedPriceMinor: price, storePlaceId: f.store || null, itineraryItemId: f.link || null, memo: f.memo, currency: cur }
    if (busy.current) return
    busy.current = true
    try {
      // 수정은 내가 바꾼 필드만 보낸다(편집 중 동행자가 고친 다른 필드를 오래된 값으로 덮어쓰지 않도록)
      if (item) { const mine = changedFields(item as unknown as Record<string, unknown>, data); if (Object.keys(mine).length) await updateShopping(item.id, mine) }
      else await addShopping(trip.id, data)
      onClose()
    } catch (e) { setErr((e as Error).message); busy.current = false }
  }
  return (
    <Sheet title={item ? '상품 수정' : '상품 추가'} onClose={onClose}>
      <div className="space-y-3">
        <Field label="상품명 *"><input autoFocus className={input} value={f.name} onChange={set('name')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="수량"><input inputMode="numeric" className={input} value={f.quantity} onChange={set('quantity')} /></Field>
          <Field label={`개당 예상 가격 (${cur})`}><input inputMode="decimal" className={input} value={f.price} onChange={set('price')} /></Field>
        </div>
        <Field label="구매 예정 매장 (지도 탭에서 장소를 저장하세요)">
          <select className={input} value={f.store} onChange={set('store')}><option value="">미정</option>{places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </Field>
        <Field label="연결할 일정">
          <select className={input} value={f.link} onChange={set('link')}><option value="">연결 안 함</option>{itinerary.map((i) => <option key={i.id} value={i.id}>DAY {i.dayNumber} · {i.title}</option>)}</select>
        </Field>
        <Field label="메모"><input className={input} value={f.memo} onChange={set('memo')} /></Field>
        {err && <p className="rounded-2xl bg-danger/10 p-3 text-sm text-danger" role="alert">{err}</p>}
        <div className="flex gap-2">
          {item && <button className={`${btnGhost} text-danger`} onClick={async () => { if (confirm('이 상품을 삭제할까요?')) { await deleteShopping(item.id); onClose() } }}>삭제</button>}
          <button className={`${btnPrimary} flex-1`} onClick={save}>저장</button>
        </div>
      </div>
    </Sheet>
  )
}
