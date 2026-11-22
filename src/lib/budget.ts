// 예산·지출 집계. 모든 금액은 원화(home) 최소 단위 정수라서 합계가 정확하다.
import type { Expense, ExpenseCategory, ItemKind } from '../db/types'

export interface CategoryRow { id: string; name: string; budgetMinor: number; spentMinor: number; pct: number | null; over: boolean }
export interface BudgetSummary {
  totalBudgetMinor: number
  spentMinor: number
  remainingMinor: number
  usedPct: number | null        // 예산이 없으면 null
  overBudget: boolean
  overByMinor: number
  todayMinor: number
  byCategory: CategoryRow[]
  byDay: { date: string; totalMinor: number }[]
  topCategory: CategoryRow | null
  sharedMinor: number           // 공동 경비 합계
  personalMinor: number         // 개인 경비 합계
  count: number
}

/** 여행지 시간대 기준 날짜('YYYY-MM-DD'). 결제 시각이 자정 근처여도 현지 날짜로 묶는다. */
export function dateIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

export function summarizeBudget(args: { totalBudgetMinor: number; categories: ExpenseCategory[]; expenses: Expense[]; timeZone: string; now?: number }): BudgetSummary {
  const live = args.expenses.filter((e) => e.deletedAt === null)
  const cats = args.categories.filter((c) => c.deletedAt === null).sort((a, b) => a.sortOrder - b.sortOrder)
  const today = dateIn(args.now ?? Date.now(), args.timeZone)

  const spentByCat = new Map<string, number>()
  const byDay = new Map<string, number>()
  let spent = 0, todayMinor = 0, shared = 0, personal = 0
  for (const e of live) {
    const v = e.money.homeMinor
    spent += v
    spentByCat.set(e.categoryId, (spentByCat.get(e.categoryId) ?? 0) + v)
    const d = dateIn(e.paidAt, args.timeZone)
    byDay.set(d, (byDay.get(d) ?? 0) + v)
    if (d === today) todayMinor += v
    if (e.money.shared) shared += v; else personal += v
  }
  const rows: CategoryRow[] = cats.map((c) => {
    const s = spentByCat.get(c.id) ?? 0
    return { id: c.id, name: c.name, budgetMinor: c.budgetMinor, spentMinor: s, pct: c.budgetMinor > 0 ? Math.round((s / c.budgetMinor) * 100) : null, over: c.budgetMinor > 0 && s > c.budgetMinor }
  })
  // 삭제된 항목에 남아 있는 지출도 합계에서 빠지지 않도록 "삭제된 항목"으로 보여준다
  const known = new Set(cats.map((c) => c.id))
  let orphan = 0
  for (const [id, v] of spentByCat) if (!known.has(id)) orphan += v
  if (orphan > 0) rows.push({ id: '_deleted', name: '삭제된 항목', budgetMinor: 0, spentMinor: orphan, pct: null, over: false })

  const total = args.totalBudgetMinor
  return {
    totalBudgetMinor: total, spentMinor: spent, remainingMinor: total - spent,
    usedPct: total > 0 ? Math.round((spent / total) * 100) : null,
    overBudget: total > 0 && spent > total, overByMinor: total > 0 && spent > total ? spent - total : 0,
    todayMinor, byCategory: rows, byDay: [...byDay].map(([date, totalMinor]) => ({ date, totalMinor })).sort((a, b) => a.date.localeCompare(b.date)),
    topCategory: rows.filter((r) => r.spentMinor > 0).sort((a, b) => b.spentMinor - a.spentMinor)[0] ?? null,
    sharedMinor: shared, personalMinor: personal, count: live.length,
  }
}

/** 일정 종류에 맞는 기본 지출 항목 이름(기본 항목 이름이 바뀌었으면 null) */
export const CATEGORY_HINT: Record<ItemKind, string> = {
  flight: '항공 및 교통', airport: '항공 및 교통', transit: '항공 및 교통', lodging_in: '숙박', lodging_out: '숙박',
  meal: '식비', sight: '관광 및 입장료', shopping: '쇼핑', other: '기타',
}
