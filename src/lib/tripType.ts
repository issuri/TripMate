// 국내/해외 여행 구분. 별도 저장 필드 없이 "한국 시간대 + 원화"이면 국내 여행으로 본다(서버·DB 변경 불필요).
// 해외에서 한국 시간대와 원화를 쓰는 여행은 현실적으로 없으므로 이 기준으로 충분하다.
export const HOME_TZ = 'Asia/Seoul'
export const HOME_CURRENCY = 'KRW'

export const isDomestic = (t: { timeZone?: string | null; localCurrency?: string | null }): boolean =>
  (t.timeZone ?? HOME_TZ) === HOME_TZ && (t.localCurrency ?? HOME_CURRENCY) === HOME_CURRENCY

/** 해외 여행으로 바꿀 때 먼저 선택해 두는 값(바로 바꿀 수 있게 가장 흔한 여행지) */
export const FOREIGN_DEFAULT = { timeZone: 'Asia/Tokyo', localCurrency: 'JPY' }

export const CHECKLIST_ABROAD = ['여권 확인', '항공권/예약 확인', '환전', '로밍/유심', '충전기/어댑터', '여행자 보험']
export const CHECKLIST_DOMESTIC = ['숙소·교통편 예약 확인', '신분증', '결제 수단(카드·현금)', '충전기·보조배터리', '상비약', '날씨·도로 상황 확인']

export const checklistFor = (t: { timeZone?: string | null; localCurrency?: string | null }) => (isDomestic(t) ? CHECKLIST_DOMESTIC : CHECKLIST_ABROAD)
export const eveReminderBody = (t: { timeZone?: string | null; localCurrency?: string | null }) =>
  isDomestic(t) ? '예약 내역, 신분증, 충전기를 확인하세요.' : '여권, 충전기, 예약 내역을 확인하세요.'
