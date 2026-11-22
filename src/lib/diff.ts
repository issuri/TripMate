/**
 * 편집 화면이 열릴 때의 값(base)과 비교해 사용자가 실제로 바꾼 필드만 골라낸다.
 * 저장 시 전체 필드를 보내면, 편집하는 동안 동행자가 고친 다른 필드를 화면에 있던 오래된 값으로 되돌리게 된다.
 */
export function changedFields<T extends Record<string, unknown>>(base: Record<string, unknown>, next: T): Partial<T> {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  return Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== undefined && !same(v, base[k]))) as Partial<T>
}
