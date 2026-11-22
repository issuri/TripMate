import type { ItemKind } from '../db/types'

// 일정 제목에서 종류를 추측한다. 확실하지 않으면 null(= 바꾸지 않는다). 위에서부터 먼저 맞는 규칙을 쓴다.
const RULES: [ItemKind, RegExp][] = [
  ['lodging_out', /체크\s*-?\s*아웃|check\s*-?\s*out/i],
  ['lodging_in', /체크\s*-?\s*인|check\s*-?\s*in|숙소|호텔|리조트|펜션|게스트\s*하우스|에어비앤비|airbnb|료칸/i],
  ['flight', /항공|비행|탑승|출국|귀국|flight|boarding|이륙|착륙/i],
  ['meal', /식사|점심|저녁|아침|조식|석식|브런치|런치|디너|맛집|식당|카페|디저트|술집|맥주|와인|바비큐|라멘|스시|파스타|곱창|국밥|회식/i],
  ['shopping', /쇼핑|면세|마트|백화점|아울렛|쇼핑몰|기념품|올리브영|돈키호테|시장/i],
  ['airport', /공항|터미널|airport/i],
  ['transit', /이동|버스|지하철|기차|열차|ktx|srt|택시|렌터카|렌트|환승|페리|배편|셔틀|출발|도착/i],
  ['sight', /관광|구경|투어|박물관|미술관|궁|사원|성당|해변|전망대|공원|산책|트레킹|등산|테마파크|놀이공원|워터파크|온천|체험/i],
]

/** 제목으로 알 수 있는 일정 종류. 알 수 없으면 null. */
export function suggestKind(title: string): ItemKind | null {
  const t = title.trim()
  if (t.length < 2) return null
  for (const [kind, re] of RULES) if (re.test(t)) return kind
  return null
}
