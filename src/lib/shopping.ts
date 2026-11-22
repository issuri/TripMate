import type { ShoppingItem } from '../db/types'

export interface ShoppingSummary {
  expectedMinor: number      // 전체 예상(가격×수량)
  remainingExpectedMinor: number // 아직 안 산 상품의 예상
  actualMinor: number        // 사용자가 입력한 실제 결제 금액 합계
  purchasedCount: number
  unpricedPurchased: number  // 구매 완료지만 실제 금액을 아직 입력하지 않은 수
  budgetMinor: number
  /** 예산 대비: 실제 지출 + 남은 예상 */
  projectedMinor: number
  overBudget: boolean
}

export function summarizeShopping(items: ShoppingItem[], budgetMinor: number): ShoppingSummary {
  const live = items.filter((i) => i.deletedAt === null)
  const expectedMinor = live.reduce((s, i) => s + i.expectedPriceMinor * i.quantity, 0)
  const remainingExpectedMinor = live.filter((i) => !i.purchased).reduce((s, i) => s + i.expectedPriceMinor * i.quantity, 0)
  const actualMinor = live.reduce((s, i) => s + (i.purchased ? i.actualPriceMinor ?? 0 : 0), 0)
  const projectedMinor = actualMinor + remainingExpectedMinor
  return {
    expectedMinor, remainingExpectedMinor, actualMinor,
    purchasedCount: live.filter((i) => i.purchased).length,
    unpricedPurchased: live.filter((i) => i.purchased && i.actualPriceMinor == null).length,
    budgetMinor, projectedMinor, overBudget: budgetMinor > 0 && projectedMinor > budgetMinor,
  }
}
