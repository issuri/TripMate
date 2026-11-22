/* 서비스워커: 오프라인 캐시 + 알림 클릭 처리 + (서버 푸시용) push 수신.
 * 이 파일은 워커 환경에서 실행되며 앱 타입 검사 대상에서 제외된다. 로직은 swlogic.ts(테스트 가능)에 있다. */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { parsePush, routeNotificationClick } from './swlogic'

declare const self: any // eslint-disable-line @typescript-eslint/no-explicit-any

// 앱이 서비스되는 경로: 도메인 맨 앞이면 '/', 하위 경로면 '/TripMate/' 같은 값(서비스 워커가 등록된 범위와 같다)
const BASE: string = new URL(self.registration.scope).pathname

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)
// 오프라인에서 /trips/... 같은 앱 내 주소로 새로고침해도 앱이 열리도록
registerRoute(new NavigationRoute(createHandlerBoundToURL(BASE + 'index.html')))

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e: any) => e.waitUntil(self.clients.claim()))

// 알림을 누르면 해당 일정 화면으로 이동
self.addEventListener('notificationclick', (event: any) => {
  event.notification.close()
  event.waitUntil(routeNotificationClick(self.clients, self.location.origin, event.notification.data?.url, BASE))
})

// 서버 푸시 수신(앱이 꺼져 있어도 동작). 서버가 {title, body, url, tag} JSON을 보낸다. 서버 구성은 별도 단계.
self.addEventListener('push', (event: any) => {
  const p = parsePush(() => event.data)
  event.waitUntil(self.registration.showNotification(p.title, { body: p.body, tag: p.tag, icon: BASE + 'icon.svg', badge: BASE + 'icon.svg', data: { url: p.url } }))
})
