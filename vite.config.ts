import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
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
        orientation: 'portrait',
        start_url: '/',
        theme_color: '#ffc4da',
        background_color: '#f3f4f8',
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
})
