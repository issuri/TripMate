// 서비스워커에서 쓰는 순수 로직(워커 전역 객체에 의존하지 않아 단위 테스트가 가능하다).

interface ClientLike { url: string; focus(): Promise<unknown>; postMessage(m: unknown): void }
interface ClientsLike { matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<ClientLike[]>; openWindow(url: string): Promise<unknown> }

/** 앱이 도메인 맨 앞이 아닌 하위 경로(예: /TripMate/)에서 서비스될 때, 앱 안의 주소('/trips/1')를 실제 주소로 바꾼다. base 는 '/' 또는 '/TripMate/' 꼴. */
export const withBase = (base: string, path: string): string => base.replace(/\/+$/, '') + path

/**
 * 같은 출처의 앱 창이 있으면 그 창을 앞으로 가져와 해당 일정으로 이동시키고, 없으면 새 창으로 연다. 외부 주소는 열지 않는다.
 * rawUrl 은 앱 안의 주소('/trips/…')이고, 새 창으로 열 때만 base 를 붙인다(열려 있는 창에는 앱의 라우터가 알아서 이동한다).
 */
export async function routeNotificationClick(clients: ClientsLike, origin: string, rawUrl: unknown, base = '/'): Promise<'focused' | 'opened'> {
  const url = typeof rawUrl === 'string' && rawUrl.startsWith('/') && !rawUrl.startsWith('//') ? rawUrl : '/'
  const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const w of wins) {
    if (new URL(w.url).origin === origin) {
      await w.focus()
      w.postMessage({ type: 'navigate', url })
      return 'focused'
    }
  }
  await clients.openWindow(withBase(base, url))
  return 'opened'
}

export interface PushPayload { title: string; body: string; tag?: string; url: string }

/** 서버 푸시 payload 해석. 형식이 이상해도 알림이 사라지지 않도록 기본값으로 대체한다. */
export function parsePush(read: () => { json(): unknown; text(): string } | null | undefined): PushPayload {
  const d = read()
  let p: Record<string, unknown> = {}
  try { p = (d?.json() as Record<string, unknown>) ?? {} } catch { p = { body: d?.text?.() ?? '' } }
  const url = typeof p.url === 'string' && p.url.startsWith('/') && !p.url.startsWith('//') ? p.url : '/'
  return { title: typeof p.title === 'string' && p.title ? p.title : '일정 알림', body: typeof p.body === 'string' ? p.body : '', tag: typeof p.tag === 'string' ? p.tag : undefined, url }
}
