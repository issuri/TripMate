// 여행지 선택 목록: 시간대(알림 기준)와 통화. 시간대 이름은 IANA 표준 이름이다.
// 목록에 없는 값이 이미 저장된 여행도 있으므로, 화면에서는 현재 값을 항상 선택지에 포함한다(withCurrent).

export interface TzGroup { group: string; zones: [id: string, label: string][] }

export const TIME_ZONE_GROUPS: TzGroup[] = [
  { group: '동아시아', zones: [
    ['Asia/Seoul', '한국'], ['Asia/Tokyo', '일본'], ['Asia/Shanghai', '중국'], ['Asia/Hong_Kong', '홍콩'], ['Asia/Macau', '마카오'],
    ['Asia/Taipei', '대만'], ['Asia/Ulaanbaatar', '몽골'], ['Asia/Vladivostok', '러시아(블라디보스토크)'],
  ] },
  { group: '동남아시아', zones: [
    ['Asia/Singapore', '싱가포르'], ['Asia/Bangkok', '태국'], ['Asia/Ho_Chi_Minh', '베트남'], ['Asia/Phnom_Penh', '캄보디아'], ['Asia/Vientiane', '라오스'], ['Asia/Yangon', '미얀마'], ['Asia/Kuala_Lumpur', '말레이시아'], ['Asia/Manila', '필리핀'],
    ['Asia/Jakarta', '인도네시아(자카르타)'], ['Asia/Makassar', '인도네시아(발리)'], ['Asia/Brunei', '브루나이'], ['Asia/Dili', '동티모르'],
  ] },
  { group: '남·서·중앙아시아', zones: [
    ['Asia/Kolkata', '인도'], ['Asia/Kathmandu', '네팔'], ['Asia/Colombo', '스리랑카'], ['Asia/Dhaka', '방글라데시'], ['Indian/Maldives', '몰디브'],
    ['Asia/Dubai', '아랍에미리트'], ['Asia/Qatar', '카타르'], ['Asia/Riyadh', '사우디아라비아'], ['Asia/Jerusalem', '이스라엘'],
    ['Europe/Istanbul', '튀르키예'], ['Asia/Tashkent', '우즈베키스탄'], ['Asia/Almaty', '카자흐스탄'],
    ['Asia/Karachi', '파키스탄'], ['Asia/Tehran', '이란'], ['Asia/Baghdad', '이라크'], ['Asia/Amman', '요르단'], ['Asia/Beirut', '레바논'],
    ['Asia/Kuwait', '쿠웨이트'], ['Asia/Muscat', '오만'], ['Asia/Bahrain', '바레인'], ['Asia/Kabul', '아프가니스탄'], ['Asia/Thimphu', '부탄'],
    ['Asia/Tbilisi', '조지아'], ['Asia/Yerevan', '아르메니아'], ['Asia/Baku', '아제르바이잔'], ['Asia/Bishkek', '키르기스스탄'],
  ] },
  { group: '유럽', zones: [
    ['Europe/London', '영국'], ['Europe/Dublin', '아일랜드'], ['Europe/Lisbon', '포르투갈'], ['Atlantic/Reykjavik', '아이슬란드'],
    ['Europe/Paris', '프랑스'], ['Europe/Madrid', '스페인'], ['Europe/Rome', '이탈리아'], ['Europe/Berlin', '독일'], ['Europe/Amsterdam', '네덜란드'],
    ['Europe/Brussels', '벨기에'], ['Europe/Zurich', '스위스'], ['Europe/Vienna', '오스트리아'], ['Europe/Prague', '체코'], ['Europe/Budapest', '헝가리'],
    ['Europe/Warsaw', '폴란드'], ['Europe/Zagreb', '크로아티아'], ['Europe/Copenhagen', '덴마크'], ['Europe/Stockholm', '스웨덴'], ['Europe/Oslo', '노르웨이'],
    ['Europe/Helsinki', '핀란드'], ['Europe/Athens', '그리스'], ['Europe/Moscow', '러시아(모스크바)'],
    ['Europe/Kyiv', '우크라이나'], ['Europe/Bucharest', '루마니아'], ['Europe/Sofia', '불가리아'], ['Europe/Belgrade', '세르비아'],
    ['Europe/Sarajevo', '보스니아'], ['Europe/Ljubljana', '슬로베니아'], ['Europe/Bratislava', '슬로바키아'], ['Europe/Tallinn', '에스토니아'],
    ['Europe/Riga', '라트비아'], ['Europe/Vilnius', '리투아니아'], ['Europe/Luxembourg', '룩셈부르크'], ['Europe/Malta', '몰타'],
    ['Europe/Monaco', '모나코'], ['Europe/Tirane', '알바니아'], ['Europe/Podgorica', '몬테네그로'],
  ] },
  { group: '아프리카', zones: [
    ['Africa/Cairo', '이집트'], ['Africa/Casablanca', '모로코'], ['Africa/Nairobi', '케냐'], ['Africa/Johannesburg', '남아프리카공화국'],
    ['Africa/Tunis', '튀니지'], ['Africa/Algiers', '알제리'], ['Africa/Lagos', '나이지리아'], ['Africa/Accra', '가나'],
    ['Africa/Addis_Ababa', '에티오피아'], ['Africa/Dar_es_Salaam', '탄자니아'], ['Indian/Mauritius', '모리셔스'], ['Indian/Mahe', '세이셸'],
  ] },
  { group: '북·중남미', zones: [
    ['America/New_York', '미국 동부'], ['America/Chicago', '미국 중부'], ['America/Denver', '미국 산악'], ['America/Los_Angeles', '미국 서부'],
    ['America/Anchorage', '알래스카'], ['Pacific/Honolulu', '하와이'], ['America/Toronto', '캐나다 동부'], ['America/Vancouver', '캐나다 서부'],
    ['America/Mexico_City', '멕시코'], ['America/Cancun', '멕시코(칸쿤)'], ['America/Bogota', '콜롬비아'], ['America/Lima', '페루'],
    ['America/Sao_Paulo', '브라질'], ['America/Argentina/Buenos_Aires', '아르헨티나'], ['America/Santiago', '칠레'],
    ['America/Phoenix', '미국 애리조나'], ['America/Halifax', '캐나다 대서양'], ['America/Edmonton', '캐나다 산악'], ['America/Panama', '파나마'],
    ['America/Costa_Rica', '코스타리카'], ['America/Havana', '쿠바'], ['America/Jamaica', '자메이카'], ['America/Puerto_Rico', '푸에르토리코'],
    ['America/Santo_Domingo', '도미니카공화국'], ['America/Nassau', '바하마'], ['America/Montevideo', '우루과이'], ['America/Caracas', '베네수엘라'],
    ['America/La_Paz', '볼리비아'], ['America/Guayaquil', '에콰도르'],
  ] },
  { group: '오세아니아', zones: [
    ['Australia/Sydney', '호주 동부(시드니·멜버른)'], ['Australia/Brisbane', '호주(브리즈번)'], ['Australia/Perth', '호주 서부'],
    ['Pacific/Auckland', '뉴질랜드'], ['Pacific/Guam', '괌·사이판'], ['Pacific/Fiji', '피지'],
    ['Australia/Adelaide', '호주(애들레이드)'], ['Australia/Darwin', '호주(다윈)'], ['Australia/Hobart', '호주(태즈메이니아)'],
    ['Pacific/Tahiti', '타히티'], ['Pacific/Noumea', '뉴칼레도니아'], ['Pacific/Port_Moresby', '파푸아뉴기니'], ['Pacific/Palau', '팔라우'],
    ['Pacific/Pago_Pago', '사모아(미국령)'], ['Pacific/Apia', '사모아'], ['Pacific/Tongatapu', '통가'], ['Pacific/Rarotonga', '쿡 제도'],
  ] },
]

export const TIME_ZONES = TIME_ZONE_GROUPS.flatMap((g) => g.zones)

/** [코드, 한국어 이름]. 소수 자릿수가 2가 아닌 통화는 lib/money.ts 의 MINOR_DIGITS 에도 있어야 한다. */
export const CURRENCY_LIST: [code: string, label: string][] = [
  ['KRW', '원'], ['JPY', '엔'], ['USD', '미국 달러'], ['EUR', '유로'], ['GBP', '영국 파운드'], ['CNY', '위안'],
  ['HKD', '홍콩 달러'], ['MOP', '마카오 파타카'], ['TWD', '대만 달러'], ['SGD', '싱가포르 달러'],
  ['THB', '바트'], ['VND', '동'], ['IDR', '루피아'], ['MYR', '링깃'], ['PHP', '필리핀 페소'], ['KHR', '리엘'], ['LAK', '킵'], ['MMK', '짯'],
  ['INR', '인도 루피'], ['NPR', '네팔 루피'], ['LKR', '스리랑카 루피'], ['MVR', '루피야'],
  ['AED', '디르함(UAE)'], ['QAR', '카타르 리얄'], ['SAR', '사우디 리얄'], ['ILS', '셰켈'], ['TRY', '튀르키예 리라'],
  ['KZT', '텡게'], ['UZS', '숨'], ['MNT', '투그릭'],
  ['CHF', '스위스 프랑'], ['SEK', '스웨덴 크로나'], ['NOK', '노르웨이 크로네'], ['DKK', '덴마크 크로네'], ['ISK', '아이슬란드 크로나'],
  ['CZK', '코루나'], ['HUF', '포린트'], ['PLN', '즐로티'], ['RON', '레우'], ['BGN', '레프'], ['RUB', '루블'],
  ['EGP', '이집트 파운드'], ['MAD', '디르함(모로코)'], ['KES', '케냐 실링'], ['ZAR', '랜드'],
  ['AUD', '호주 달러'], ['NZD', '뉴질랜드 달러'], ['FJD', '피지 달러'], ['CAD', '캐나다 달러'],
  ['MXN', '멕시코 페소'], ['COP', '콜롬비아 페소'], ['PEN', '솔'], ['BRL', '헤알'], ['ARS', '아르헨티나 페소'], ['CLP', '칠레 페소'],
]

export const CURRENCIES = CURRENCY_LIST.map(([c]) => c)

/** 목록에 없는 값(예전에 저장된 여행 등)도 선택지에 남긴다. */
export const withCurrent = <T extends string>(list: readonly T[], current: string | undefined): string[] =>
  current && !list.includes(current as T) ? [current, ...list] : [...list]

const koName = (code: string): string | undefined => {
  try { const n = new Intl.DisplayNames('ko', { type: 'currency' }).of(code); return n && n !== code ? n : undefined } catch { return undefined }
}
export const currencyLabel = (code: string) => CURRENCY_LIST.find(([c]) => c === code)?.[1] ?? koName(code)

// 이미 쓰이지 않는 통화(HRK→유로, SLL·ZWL→신권)와 통화가 아닌 국제 단위(XDR, XSU)는 제외한다.
const NOT_FOR_TRAVEL = new Set(['XDR', 'XSU', 'HRK', 'SLL', 'ZWL'])

/** 위 목록에 없는 나머지 모든 통화(이 기기가 아는 ISO 4217 코드). 아주 오래된 브라우저는 빈 배열. */
export function otherCurrencies(): string[] {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('currency') ?? []
    const have = new Set(CURRENCIES)
    return all.filter((c) => /^[A-Z]{3}$/.test(c) && !have.has(c) && !NOT_FOR_TRAVEL.has(c)).sort()
  } catch { return [] }
}
