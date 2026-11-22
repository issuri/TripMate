import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { loadEnv, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * 공개 사이트용 보호 설정(CSP): 이 앱 자신의 스크립트만 실행하고, 서버 연결은 지도·장소 검색(OpenStreetMap)과
 * (설정한 경우) 내 Supabase 로만 허용한다. 호스팅(GitHub Pages)에서는 응답 헤더를 못 바꾸므로 meta 태그로 넣는다. 빌드할 때만 적용한다.
 */
function csp(supabaseUrl?: string): Plugin {
  const sb = (() => { try { const u = new URL(supabaseUrl ?? ''); return `${u.origin} wss://${u.host}` } catch { return '' } })()
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",                       // 지도 라이브러리와 화면 일부가 인라인 스타일을 쓴다
    "img-src 'self' data: blob: https://tile.openstreetmap.org",
    "font-src 'self' data:",
    `connect-src 'self' https://nominatim.openstreetmap.org ${sb}`.trim(),
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  return {
    name: 'tripmate-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  }
}

export default defineConfig(({ mode }) => {
// 앱이 서비스되는 경로. 기본은 도메인 맨 앞('/'). GitHub Pages 의 저장소 주소(…github.io/저장소이름/)에서는 배포할 때 VITE_BASE=/저장소이름/ 으로 지정한다.
const base = loadEnv(mode, process.cwd(), 'VITE_').VITE_BASE || '/'
return {
  base,
  plugins: [
    csp(loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest', // 알림 클릭/푸시 처리를 위해 직접 만든 서비스워커(src/sw.ts) 사용
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: {
        name: 'TripMate 여행 가이드',
        short_name: 'TripMate',
        description: '여행 준비부터 귀국까지 올인원 여행 관리',
        lang: 'ko',
        display: 'standalone',
        start_url: base,   // 시작 주소와 범위는 앱이 서비스되는 경로와 같아야 한다(범위 밖이면 홈 화면 앱이 열리지 않는다)
        scope: base,
        theme_color: '#ffc4da',
        background_color: '#f8f4f7',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'] },
    }),
  ],
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}
})
