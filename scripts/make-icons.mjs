// public/icon.svg 에서 홈 화면용 PNG 아이콘을 만든다. 실행: npm run icons
// (iOS 홈 화면 아이콘은 SVG를 지원하지 않아 PNG가 필요하다)
import sharp from 'sharp'
import { readFile } from 'node:fs/promises'

const svg = await readFile(new URL('../public/icon.svg', import.meta.url))
const out = (name) => new URL(`../public/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

// 배경이 꽉 찬 정사각형이라 maskable(가장자리가 잘려도 비행기는 안전 영역 안)과 apple-touch-icon 모두에 그대로 쓴다
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]]) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out(name))
  console.log('made', name)
}
