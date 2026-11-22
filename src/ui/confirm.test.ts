import { afterEach, describe, expect, it, vi } from 'vitest'
import { askConfirm } from './kit'

// 확인창 자리(ConfirmHost)가 없는 환경에서의 동작: 브라우저 confirm 으로 대신하고, 그것도 없으면 "취소"로 본다(삭제하지 않는 쪽).
describe('askConfirm without a host', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it('falls back to the browser confirm and returns its answer', async () => {
    const fn = vi.fn(() => true)
    vi.stubGlobal('confirm', fn)
    expect(await askConfirm('삭제할까요?', { confirmLabel: '삭제' })).toBe(true)
    expect(fn).toHaveBeenCalledWith('삭제할까요?')
    vi.stubGlobal('confirm', () => false)
    expect(await askConfirm('삭제할까요?')).toBe(false)
  })
  it('treats a missing confirm as "cancel", so nothing is deleted by accident', async () => {
    vi.stubGlobal('confirm', undefined)
    expect(await askConfirm('삭제할까요?')).toBe(false)
  })
})
