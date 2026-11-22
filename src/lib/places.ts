// 여행지 선택: 지역 하나를 고르면 국가 이름, 현지 시간대(알림 기준), 추천 통화가 함께 정해진다.
// 시간대 ID와 한국어 지역 이름은 locales.ts 의 TIME_ZONES 를 쓰고, 여기서는 나라 이름·추천 통화·검색어만 덧붙인다.
import { TIME_ZONE_GROUPS } from './locales'

export const CONTINENTS = ['아시아', '유럽', '아프리카', '아메리카', '오세아니아'] as const
export type Continent = (typeof CONTINENTS)[number]

// locales.ts 의 지역 묶음 → 대륙
const CONTINENT_OF_GROUP: Record<string, Continent> = {
  '동아시아': '아시아', '동남아시아': '아시아', '남·서·중앙아시아': '아시아', '유럽': '유럽', '아프리카': '아프리카', '북·중남미': '아메리카', '오세아니아': '오세아니아',
}

export interface Place { id: string; label: string; country: string; currency: string; keywords: string; continent: Continent }

// id: [국가, 추천 통화, 검색어(도시·별칭)]. 추천 통화는 화면에서 바꿀 수 있다.
const META: Record<string, [country: string, currency: string, keywords?: string]> = {
  'Asia/Seoul': ['대한민국', 'KRW'],
  'Asia/Tokyo': ['일본', 'JPY', '도쿄 오사카 교토 후쿠오카 삿포로 나고야 오키나와 tokyo osaka'],
  'Asia/Shanghai': ['중국', 'CNY', '베이징 상하이 광저우 선전 청두 칭다오 beijing'],
  'Asia/Hong_Kong': ['홍콩', 'HKD'],
  'Asia/Macau': ['마카오', 'MOP'],
  'Asia/Taipei': ['대만', 'TWD', '타이베이 타이페이 가오슝 타이중'],
  'Asia/Ulaanbaatar': ['몽골', 'MNT', '울란바토르'],
  'Asia/Vladivostok': ['러시아', 'RUB', '블라디보스토크'],
  'Asia/Singapore': ['싱가포르', 'SGD'],
  'Asia/Bangkok': ['태국', 'THB', '방콕 파타야 치앙마이 푸켓 bangkok'],
  'Asia/Ho_Chi_Minh': ['베트남', 'VND', '호치민 하노이 다낭 나트랑 푸꾸옥 달랏'],
  'Asia/Phnom_Penh': ['캄보디아', 'KHR', '프놈펜 시엠립 앙코르'],
  'Asia/Vientiane': ['라오스', 'LAK', '비엔티안 루앙프라방 방비엥'],
  'Asia/Yangon': ['미얀마', 'MMK', '양곤'],
  'Asia/Kuala_Lumpur': ['말레이시아', 'MYR', '쿠알라룸푸르 코타키나발루 페낭 랑카위'],
  'Asia/Manila': ['필리핀', 'PHP', '마닐라 세부 보라카이 보홀 클락'],
  'Asia/Jakarta': ['인도네시아', 'IDR', '자카르타 반둥 족자카르타'],
  'Asia/Makassar': ['인도네시아', 'IDR', '발리 롬복 덴파사르'],
  'Asia/Brunei': ['브루나이', 'BND'],
  'Asia/Dili': ['동티모르', 'USD'],
  'Asia/Kolkata': ['인도', 'INR', '델리 뭄바이 고아 자이푸르'],
  'Asia/Kathmandu': ['네팔', 'NPR', '카트만두 포카라'],
  'Asia/Colombo': ['스리랑카', 'LKR', '콜롬보'],
  'Asia/Dhaka': ['방글라데시', 'BDT', '다카'],
  'Indian/Maldives': ['몰디브', 'MVR', '말레'],
  'Asia/Dubai': ['아랍에미리트', 'AED', '두바이 아부다비 uae'],
  'Asia/Qatar': ['카타르', 'QAR', '도하'],
  'Asia/Riyadh': ['사우디아라비아', 'SAR', '리야드 제다 메카'],
  'Asia/Jerusalem': ['이스라엘', 'ILS', '예루살렘 텔아비브'],
  'Europe/Istanbul': ['튀르키예', 'TRY', '터키 이스탄불 카파도키아 앙카라 안탈리아'],
  'Asia/Tashkent': ['우즈베키스탄', 'UZS', '타슈켄트 사마르칸트'],
  'Asia/Almaty': ['카자흐스탄', 'KZT', '알마티 아스타나'],
  'Asia/Karachi': ['파키스탄', 'PKR', '카라치 이슬라마바드 라호르'],
  'Asia/Tehran': ['이란', 'IRR', '테헤란'],
  'Asia/Baghdad': ['이라크', 'IQD', '바그다드'],
  'Asia/Amman': ['요르단', 'JOD', '암만 페트라'],
  'Asia/Beirut': ['레바논', 'LBP', '베이루트'],
  'Asia/Kuwait': ['쿠웨이트', 'KWD'],
  'Asia/Muscat': ['오만', 'OMR', '무스카트'],
  'Asia/Bahrain': ['바레인', 'BHD', '마나마'],
  'Asia/Kabul': ['아프가니스탄', 'AFN', '카불'],
  'Asia/Thimphu': ['부탄', 'BTN', '팀부'],
  'Asia/Tbilisi': ['조지아', 'GEL', '트빌리시'],
  'Asia/Yerevan': ['아르메니아', 'AMD', '예레반'],
  'Asia/Baku': ['아제르바이잔', 'AZN', '바쿠'],
  'Asia/Bishkek': ['키르기스스탄', 'KGS', '비슈케크'],
  'Europe/London': ['영국', 'GBP', '런던 에든버러 맨체스터 스코틀랜드 잉글랜드 uk'],
  'Europe/Dublin': ['아일랜드', 'EUR', '더블린'],
  'Europe/Lisbon': ['포르투갈', 'EUR', '리스본 포르투'],
  'Atlantic/Reykjavik': ['아이슬란드', 'ISK', '레이캬비크'],
  'Europe/Paris': ['프랑스', 'EUR', '파리 니스 리옹 마르세유'],
  'Europe/Madrid': ['스페인', 'EUR', '마드리드 바르셀로나 세비야 마요르카'],
  'Europe/Rome': ['이탈리아', 'EUR', '로마 밀라노 베네치아 피렌체 나폴리'],
  'Europe/Berlin': ['독일', 'EUR', '베를린 뮌헨 프랑크푸르트 함부르크'],
  'Europe/Amsterdam': ['네덜란드', 'EUR', '암스테르담'],
  'Europe/Brussels': ['벨기에', 'EUR', '브뤼셀'],
  'Europe/Zurich': ['스위스', 'CHF', '취리히 인터라켄 제네바 루체른'],
  'Europe/Vienna': ['오스트리아', 'EUR', '빈 비엔나 잘츠부르크'],
  'Europe/Prague': ['체코', 'CZK', '프라하'],
  'Europe/Budapest': ['헝가리', 'HUF', '부다페스트'],
  'Europe/Warsaw': ['폴란드', 'PLN', '바르샤바 크라쿠프'],
  'Europe/Zagreb': ['크로아티아', 'EUR', '자그레브 두브로브니크 스플리트'],
  'Europe/Copenhagen': ['덴마크', 'DKK', '코펜하겐'],
  'Europe/Stockholm': ['스웨덴', 'SEK', '스톡홀름'],
  'Europe/Oslo': ['노르웨이', 'NOK', '오슬로 베르겐'],
  'Europe/Helsinki': ['핀란드', 'EUR', '헬싱키'],
  'Europe/Athens': ['그리스', 'EUR', '아테네 산토리니 미코노스'],
  'Europe/Moscow': ['러시아', 'RUB', '모스크바 상트페테르부르크'],
  'Europe/Kyiv': ['우크라이나', 'UAH', '키예프 키이우'],
  'Europe/Bucharest': ['루마니아', 'RON', '부쿠레슈티'],
  'Europe/Sofia': ['불가리아', 'EUR', '소피아'],
  'Europe/Belgrade': ['세르비아', 'RSD', '베오그라드'],
  'Europe/Sarajevo': ['보스니아 헤르체고비나', 'BAM', '사라예보'],
  'Europe/Ljubljana': ['슬로베니아', 'EUR', '류블랴나'],
  'Europe/Bratislava': ['슬로바키아', 'EUR', '브라티슬라바'],
  'Europe/Tallinn': ['에스토니아', 'EUR', '탈린'],
  'Europe/Riga': ['라트비아', 'EUR', '리가'],
  'Europe/Vilnius': ['리투아니아', 'EUR', '빌뉴스'],
  'Europe/Luxembourg': ['룩셈부르크', 'EUR'],
  'Europe/Malta': ['몰타', 'EUR', '발레타'],
  'Europe/Monaco': ['모나코', 'EUR'],
  'Europe/Tirane': ['알바니아', 'ALL', '티라나'],
  'Europe/Podgorica': ['몬테네그로', 'EUR', '포드고리차'],
  'Africa/Cairo': ['이집트', 'EGP', '카이로 룩소르'],
  'Africa/Casablanca': ['모로코', 'MAD', '카사블랑카 마라케시'],
  'Africa/Nairobi': ['케냐', 'KES', '나이로비'],
  'Africa/Johannesburg': ['남아프리카공화국', 'ZAR', '남아공 요하네스버그 케이프타운'],
  'Africa/Tunis': ['튀니지', 'TND', '튀니스'],
  'Africa/Algiers': ['알제리', 'DZD', '알제'],
  'Africa/Lagos': ['나이지리아', 'NGN', '라고스'],
  'Africa/Accra': ['가나', 'GHS', '아크라'],
  'Africa/Addis_Ababa': ['에티오피아', 'ETB', '아디스아바바'],
  'Africa/Dar_es_Salaam': ['탄자니아', 'TZS', '다르에스살람 잔지바르 킬리만자로'],
  'Indian/Mauritius': ['모리셔스', 'MUR'],
  'Indian/Mahe': ['세이셸', 'SCR'],
  'America/New_York': ['미국', 'USD', '뉴욕 워싱턴 보스턴 마이애미 플로리다 올랜도 동부'],
  'America/Chicago': ['미국', 'USD', '시카고 휴스턴 댈러스 뉴올리언스 중부'],
  'America/Denver': ['미국', 'USD', '덴버 솔트레이크 산악'],
  'America/Los_Angeles': ['미국', 'USD', '로스앤젤레스 엘에이 la 샌프란시스코 라스베이거스 시애틀 샌디에이고 서부'],
  'America/Anchorage': ['미국', 'USD', '앵커리지 알래스카'],
  'Pacific/Honolulu': ['미국', 'USD', '하와이 호놀룰루 마우이'],
  'America/Toronto': ['캐나다', 'CAD', '토론토 몬트리올 오타와 퀘벡 동부'],
  'America/Vancouver': ['캐나다', 'CAD', '밴쿠버 서부'],
  'America/Mexico_City': ['멕시코', 'MXN', '멕시코시티'],
  'America/Cancun': ['멕시코', 'MXN', '칸쿤'],
  'America/Bogota': ['콜롬비아', 'COP', '보고타'],
  'America/Lima': ['페루', 'PEN', '리마 쿠스코 마추픽추'],
  'America/Sao_Paulo': ['브라질', 'BRL', '상파울루 리우데자네이루 리우'],
  'America/Argentina/Buenos_Aires': ['아르헨티나', 'ARS', '부에노스아이레스'],
  'America/Santiago': ['칠레', 'CLP', '산티아고'],
  'America/Phoenix': ['미국', 'USD', '피닉스 애리조나 그랜드캐니언'],
  'America/Halifax': ['캐나다', 'CAD', '핼리팩스'],
  'America/Edmonton': ['캐나다', 'CAD', '에드먼턴 캘거리 밴프 로키'],
  'America/Panama': ['파나마', 'USD', '파나마시티'],
  'America/Costa_Rica': ['코스타리카', 'CRC', '산호세'],
  'America/Havana': ['쿠바', 'CUP', '아바나'],
  'America/Jamaica': ['자메이카', 'JMD', '킹스턴'],
  'America/Puerto_Rico': ['푸에르토리코', 'USD', '산후안'],
  'America/Santo_Domingo': ['도미니카공화국', 'DOP', '산토도밍고 푼타카나'],
  'America/Nassau': ['바하마', 'BSD', '나소'],
  'America/Montevideo': ['우루과이', 'UYU', '몬테비데오'],
  'America/Caracas': ['베네수엘라', 'VES', '카라카스'],
  'America/La_Paz': ['볼리비아', 'BOB', '라파스 우유니'],
  'America/Guayaquil': ['에콰도르', 'USD', '과야킬 키토 갈라파고스'],
  'Australia/Sydney': ['호주', 'AUD', '시드니 멜버른 캔버라 동부'],
  'Australia/Brisbane': ['호주', 'AUD', '브리즈번 골드코스트 케언즈'],
  'Australia/Perth': ['호주', 'AUD', '퍼스 서부'],
  'Pacific/Auckland': ['뉴질랜드', 'NZD', '오클랜드 퀸스타운 크라이스트처치'],
  'Pacific/Guam': ['괌·사이판', 'USD', '괌 사이판 티니안 북마리아나'],
  'Pacific/Fiji': ['피지', 'FJD'],
  'Australia/Adelaide': ['호주', 'AUD', '애들레이드'],
  'Australia/Darwin': ['호주', 'AUD', '다윈 울룰루'],
  'Australia/Hobart': ['호주', 'AUD', '호바트 태즈메이니아'],
  'Pacific/Tahiti': ['프랑스령 폴리네시아', 'XPF', '타히티 보라보라'],
  'Pacific/Noumea': ['뉴칼레도니아', 'XPF', '누메아'],
  'Pacific/Port_Moresby': ['파푸아뉴기니', 'PGK'],
  'Pacific/Palau': ['팔라우', 'USD'],
  'Pacific/Pago_Pago': ['미국령 사모아', 'USD'],
  'Pacific/Apia': ['사모아', 'WST'],
  'Pacific/Tongatapu': ['통가', 'TOP'],
  'Pacific/Rarotonga': ['쿡 제도', 'NZD'],
}

export const PLACES: Place[] = TIME_ZONE_GROUPS.flatMap((g) => g.zones.map(([id, label]): Place => {
  const m = META[id]
  return { id, label, country: m?.[0] ?? '', currency: m?.[1] ?? '', keywords: m?.[2] ?? '', continent: CONTINENT_OF_GROUP[g.group] }
}))

const BY_ID = new Map(PLACES.map((p) => [p.id, p]))
export const placeOf = (id: string): Place | undefined => BY_ID.get(id)

const norm = (s: string) => s.toLowerCase().replace(/[_\s·()/,-]+/g, ' ').trim()

/**
 * 검색어로 여행지를 찾는다. 지역 이름·국가·도시·별칭·시간대 ID 어디에 있어도 된다.
 * 이름이 검색어로 시작하는 결과를 먼저 보여준다. 검색어가 비면 전체 목록(원래 순서).
 */
export function findPlaces(query: string, exclude: readonly string[] = [], continent?: Continent | null): Place[] {
  const skip = new Set(exclude)
  const pool = PLACES.filter((p) => !skip.has(p.id) && (!continent || p.continent === continent))
  const q = norm(query)
  if (!q) return pool
  const hay = (p: Place) => norm(`${p.label} ${p.country} ${p.keywords} ${p.id}`)
  const hits = pool.filter((p) => q.split(' ').every((w) => hay(p).includes(w)))
  const rank = (p: Place) => (norm(p.country).startsWith(q) || norm(p.label).startsWith(q) ? 0 : p.keywords.split(' ').some((k) => norm(k).startsWith(q)) ? 1 : 2)
  return hits.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p)
}
