import { describe, expect, it, vi } from 'vitest'
import { parsePush, routeNotificationClick, withBase } from './swlogic'

const mkClients = (wins: { url: string }[]) => {
  const focus = vi.fn(async () => {}), postMessage = vi.fn()
  const openWindow = vi.fn(async () => {})
  return { focus, postMessage, openWindow, clients: { matchAll: async () => wins.map((w) => ({ ...w, focus, postMessage })), openWindow } }
}

describe('notification click routing', () => {
  it('focuses an existing app window and tells it to navigate to the item', async () => {
    const m = mkClients([{ url: 'https://other.example/x' }, { url: 'https://app.test/trips/1' }])
    expect(await routeNotificationClick(m.clients, 'https://app.test', '/trips/1/day/2?item=abc')).toBe('focused')
    expect(m.focus).toHaveBeenCalledTimes(1)
    expect(m.postMessage).toHaveBeenCalledWith({ type: 'navigate', url: '/trips/1/day/2?item=abc' })
    expect(m.openWindow).not.toHaveBeenCalled()
  })
  it('opens a new window when the app is not open', async () => {
    const m = mkClients([])
    expect(await routeNotificationClick(m.clients, 'https://app.test', '/trips/1/day/1?item=z')).toBe('opened')
    expect(m.openWindow).toHaveBeenCalledWith('/trips/1/day/1?item=z')
  })
  it('never navigates to external or malformed URLs', async () => {
    for (const bad of ['https://evil.example/', '//evil.example', 'javascript:alert(1)', undefined, 42]) {
      const m = mkClients([])
      await routeNotificationClick(m.clients, 'https://app.test', bad)
      expect(m.openWindow).toHaveBeenCalledWith('/')
    }
  })
})

describe('when the app is served from a sub-path such as /TripMate/', () => {
  it('adds the base only when opening a new window; an open window navigates with the in-app address', async () => {
    const closed = mkClients([])
    await routeNotificationClick(closed.clients, 'https://u.github.io', '/trips/1/day/2?item=abc', '/TripMate/')
    expect(closed.openWindow).toHaveBeenCalledWith('/TripMate/trips/1/day/2?item=abc')
    const open = mkClients([{ url: 'https://u.github.io/TripMate/trips/1' }])
    await routeNotificationClick(open.clients, 'https://u.github.io', '/trips/1/day/2', '/TripMate/')
    expect(open.postMessage).toHaveBeenCalledWith({ type: 'navigate', url: '/trips/1/day/2' })   // 라우터가 base 를 알고 있다
    expect(open.openWindow).not.toHaveBeenCalled()
  })
  it('falls back to the app home inside the base for bad addresses', async () => {
    for (const bad of ['https://evil.example/', '//evil.example', undefined]) {
      const m = mkClients([])
      await routeNotificationClick(m.clients, 'https://u.github.io', bad, '/TripMate/')
      expect(m.openWindow).toHaveBeenCalledWith('/TripMate/')
    }
  })
  it('withBase handles a root base, a sub-path base and a missing trailing slash', () => {
    expect(withBase('/', '/trips/1')).toBe('/trips/1')
    expect(withBase('/TripMate/', '/trips/1')).toBe('/TripMate/trips/1')
    expect(withBase('/TripMate', '/trips/1')).toBe('/TripMate/trips/1')
    expect(withBase('/a/b/', '/')).toBe('/a/b/')
  })
})

describe('push payload parsing', () => {
  it('parses a valid payload', () => {
    const p = parsePush(() => ({ json: () => ({ title: '공항 출발', body: '30분 후', tag: 'i:start', url: '/trips/1/day/1?item=i' }), text: () => '' }))
    expect(p).toEqual({ title: '공항 출발', body: '30분 후', tag: 'i:start', url: '/trips/1/day/1?item=i' })
  })
  it('falls back to a default notification for bad data, and sanitizes the url', () => {
    expect(parsePush(() => null)).toEqual({ title: '일정 알림', body: '', tag: undefined, url: '/' })
    expect(parsePush(() => ({ json: () => { throw new Error('bad json') }, text: () => '원문 텍스트' })).body).toBe('원문 텍스트')
    expect(parsePush(() => ({ json: () => ({ title: 't', url: 'https://evil.example' }), text: () => '' })).url).toBe('/')
  })
})
