import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { listExpenses } from '../db/expenses'
import { db } from '../db/local'
import type { Trip } from '../db/types'
import { summarizeBudget } from '../lib/budget'
import { Card } from './kit'

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

/** 여행 홈의 경비 요약: 예산, 지출, 남은 예산, 사용률, 오늘 지출, 가장 많이 쓴 항목 */
export default function ExpenseSummary({ trip }: { trip: Trip }) {
  const expenses = useLiveQuery(() => listExpenses(trip.id), [trip.id]) ?? []
  const categories = useLiveQuery(() => db.expenseCategories.where('tripId').equals(trip.id).toArray(), [trip.id]) ?? []
  const s = summarizeBudget({ totalBudgetMinor: trip.totalBudgetMinor, categories, expenses, timeZone: trip.timeZone })
  const pct = s.usedPct === null ? 0 : Math.min(100, s.usedPct)
  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold">경비</h2>
        <Link to={`/trips/${trip.id}/expenses`} className="text-sm font-semibold text-signal">자세히</Link>
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div><p className="text-xs text-ink-2">총 지출</p><p className="num text-2xl font-extrabold">{won(s.spentMinor)}</p></div>
        <div className="text-right"><p className="text-xs text-ink-2">{s.overBudget ? '초과' : '남은 예산'}</p>
          <p className={`num text-lg font-bold ${s.overBudget ? 'text-danger' : ''}`}>{s.totalBudgetMinor > 0 ? won(s.overBudget ? s.overByMinor : s.remainingMinor) : '예산 미설정'}</p></div>
      </div>
      {s.totalBudgetMinor > 0 && (
        <>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-line"><div className={`h-full rounded-full ${s.overBudget ? 'bg-danger' : 'bg-mint'}`} style={{ width: `${pct}%` }} /></div>
          <p className="num mt-1.5 text-xs text-ink-2">예산 사용률 {s.usedPct}%{s.overBudget && <b className="text-danger"> · 예산 초과</b>}</p>
        </>
      )}
      <dl className="num mt-3 grid grid-cols-2 gap-2 text-sm">
        <div><dt className="text-xs text-ink-2">오늘 지출</dt><dd className="font-bold">{won(s.todayMinor)}</dd></div>
        <div><dt className="text-xs text-ink-2">가장 많이 쓴 항목</dt><dd className="truncate font-bold">{s.topCategory ? `${s.topCategory.name} ${won(s.topCategory.spentMinor)}` : '-'}</dd></div>
      </dl>
      <Link to={`/trips/${trip.id}/expenses?add=1`} className="mt-3 block rounded-2xl bg-ink py-3 text-center text-sm font-semibold text-white active:scale-[.97]">지출 추가</Link>
    </Card>
  )
}
