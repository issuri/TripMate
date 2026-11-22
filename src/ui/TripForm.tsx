import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../db/local'
import { setRemindersEnabled } from '../db/reminders'
import { updateTrip } from '../db/itinerary'
import { createTrip, deleteTrip, validateTrip } from '../db/trips'
import { changedFields } from '../lib/diff'
import { useAuth } from '../sync/auth'
import { myRole } from '../sync/sharing'
import { currencyLabel, CURRENCIES, otherCurrencies } from '../lib/locales'
import { placeOf, type Place } from '../lib/places'
import { FOREIGN_DEFAULT, HOME_CURRENCY, HOME_TZ, isDomestic } from '../lib/tripType'
import { btnGhost, btnPrimary, Card, Field, input } from './kit'
import PlacePicker from './PlacePicker'

const otherCurs = otherCurrencies()
const DEFAULT_COUNTRY = placeOf(FOREIGN_DEFAULT.timeZone)?.country ?? ''

// "새 여행"과 "여행 수정"(그리고 다른 여행의 수정 화면)이 같은 컴포넌트를 쓰므로, 여행마다 key를 달아 이전 입력값이 남지 않게 한다.
export default function TripForm() {
  const { id } = useParams()
  return <TripFormInner key={id ?? 'new'} />
}

function TripFormInner() {
  const { id } = useParams()
  const nav = useNavigate()
  const existing = useLiveQuery(() => (id ? db.trips.get(id) : undefined), [id])
  const auth = useAuth()
  const role = useLiveQuery(() => (id ? myRole(id, undefined, auth.userId) : 'admin'), [id, auth.userId])
  const [f, setF] = useState({ name: '', country: DEFAULT_COUNTRY, city: '', startDate: '', endDate: '', timeZone: FOREIGN_DEFAULT.timeZone, purpose: '', companions: '', localCurrency: FOREIGN_DEFAULT.localCurrency, coverImage: '' })
  const [abroad, setAbroad] = useState(true)   // 해외 여행(기본) / 국내 여행. 국내 여행은 한국 시간대와 원화로 정해진다
  const [editCountry, setEditCountry] = useState(false)
  const [notify, setNotify] = useState(true)   // 새 여행의 알림(이 기기). 수정 화면에서는 여행 홈의 알림 카드에서 바꾼다
  const lastForeign = useRef<{ timeZone: string; localCurrency: string; country: string }>({ ...FOREIGN_DEFAULT, country: DEFAULT_COUNTRY })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false) // 버튼 비활성화 표시용
  const submitting = useRef(false)        // 연타 방지는 ref로(상태는 같은 틱의 연속 클릭을 막지 못함)
  const loaded = useRef(false)
  const snapshot = useRef<Record<string, unknown> | null>(null)
  useEffect(() => {
    // 처음 한 번만 채운다(다른 곳에서 데이터가 바뀌어도 입력 중인 내용을 덮어쓰지 않음)
    if (existing && !loaded.current) {
      loaded.current = true
      snapshot.current = existing as unknown as Record<string, unknown> // 폼을 연 시점의 값(변경 비교 기준)
      const { name, country, city, startDate, endDate, timeZone, purpose, localCurrency } = existing
      setF({ name, country, city, startDate, endDate, timeZone, purpose, localCurrency, companions: existing.companions.join(', '), coverImage: existing.coverImage ?? '' })
      setAbroad(!isDomestic(existing))
      if (!isDomestic(existing)) lastForeign.current = { timeZone, localCurrency, country }
    }
  }, [existing])
  const chooseTripType = (toAbroad: boolean) => {
    if (toAbroad === abroad) return
    setAbroad(toAbroad)
    setErr(null)
    setF((p) => {
      if (toAbroad) return { ...p, ...lastForeign.current }
      // 다시 해외로 바꾸면 고른 값을 되돌린다. 숨겨진 국가 칸의 외국 이름이 국내 여행에 저장되지 않도록 비워 둔다.
      if (!isDomestic(p)) lastForeign.current = { timeZone: p.timeZone, localCurrency: p.localCurrency, country: p.country }
      return { ...p, timeZone: HOME_TZ, localCurrency: HOME_CURRENCY, country: '' }
    })
  }
  // 여행지를 고르면 국가 이름·현지 시간대·추천 통화가 함께 채워진다(통화와 국가는 이어서 바꿀 수 있다)
  const pickPlace = (p: Place) => {
    setErr(null)
    setF((prev) => ({ ...prev, timeZone: p.id, country: p.country, localCurrency: p.currency }))
    lastForeign.current = { timeZone: p.id, localCurrency: p.currency, country: p.country }
  }
  // 직전 값 기준으로 갱신한다(자동완성처럼 여러 칸이 연달아 바뀔 때 앞서 입력한 칸이 사라지지 않도록)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { const v = e.target.value; setF((p) => ({ ...p, [k]: v })) }
  // 종료일이 시작일보다 앞서는 값은 입력할 수 없다: 시작일을 종료일 뒤로 옮기면 종료일을 함께 옮기고, 앞선 종료일은 시작일로 되돌린다.
  const [dateNote, setDateNote] = useState<string | null>(null)
  const setStart = (v: string) => { setDateNote(null); setF((p) => (v && p.endDate && p.endDate < v ? { ...p, startDate: v, endDate: v } : { ...p, startDate: v })) }
  const setEnd = (v: string) => {
    if (v && f.startDate && v < f.startDate) { setDateNote('종료일은 시작일보다 빠를 수 없어요.'); setF((p) => ({ ...p, endDate: p.startDate })); return }
    setDateNote(null); setF((p) => ({ ...p, endDate: v }))
  }

  const onImage = (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return setErr('이미지 파일만 선택할 수 있어요.')
    const fail = () => setErr('이미지를 불러오지 못했어요. 다른 사진을 선택해 보세요.')
    const r = new FileReader()
    r.onerror = fail
    r.onload = () => {
      const img = new Image()
      img.onerror = fail
      img.onload = () => { // 오프라인 저장 용량을 위해 축소
        const s = Math.min(1, 800 / (img.width || 800)), c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s))
        const ctx = c.getContext('2d')
        if (!ctx) return fail()
        ctx.drawImage(img, 0, 0, c.width, c.height)
        setErr(null)
        setF((p) => ({ ...p, coverImage: c.toDataURL('image/jpeg', 0.75) }))
      }
      img.src = r.result as string
    }
    r.readAsDataURL(file)
  }

  const submit = async () => {
    if (submitting.current) return // 연속 탭으로 여행이 중복 생성되는 것을 방지
    if (abroad && isDomestic(f)) return setErr('해외 여행이면 현지 시간대나 통화를 골라 주세요. 한국 시간대와 원화는 국내 여행이에요.')
    const data = {
      name: f.name, country: !abroad && !f.country.trim() ? '대한민국' : f.country, city: f.city, startDate: f.startDate, endDate: f.endDate, timeZone: f.timeZone,
      purpose: f.purpose, localCurrency: f.localCurrency,
      companions: f.companions.split(',').map((s) => s.trim()).filter(Boolean), coverImage: f.coverImage || null,
    }
    const v = validateTrip(data)
    if (v) return setErr(v)
    submitting.current = true; setBusy(true)
    try {
      // 수정은 내가 바꾼 필드만 보낸다(폼을 여는 동안 동행자가 고친 다른 필드를 덮어쓰지 않도록)
      if (id) { await updateTrip(id, snapshot.current ? changedFields(snapshot.current, data) : data); nav(`/trips/${id}`) }
      else {
        const t = await createTrip(data)
        if (!notify) await setRemindersEnabled(t.id, false)    // 알림을 받지 않기로 했다면 만들자마자 예약된 알림을 지운다
        nav(`/trips/${t.id}`)
      }
    } catch (e) { setErr((e as Error).message); submitting.current = false; setBusy(false) }
  }

  // 여행 기본 정보는 관리자만 고칠 수 있다(서버도 같은 규칙으로 거부한다). 일반 동행자에게는 이유를 알려준다.
  if (id && role && role !== 'admin') {
    return (
      <main className="mx-auto max-w-lg space-y-4 px-4 pt-[calc(1.5rem+env(safe-area-inset-top))]">
        <h1 className="px-1 text-[28px] font-extrabold tracking-tight">여행 수정</h1>
        <Card><p className="font-semibold">관리자만 고칠 수 있어요</p><p className="mt-2 text-sm text-ink-2">여행 이름, 날짜, 국가·도시 같은 기본 정보는 관리자만 바꿀 수 있어요. 일정, 쇼핑 리스트, 준비물은 함께 고칠 수 있어요.</p></Card>
        <button className={`${btnGhost} w-full`} onClick={() => nav(-1)}>돌아가기</button>
      </main>
    )
  }
  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 pb-10 pt-[calc(1.5rem+env(safe-area-inset-top))]">
      <h1 className="px-1 text-[28px] font-extrabold tracking-tight">{id ? '여행 수정' : '새 여행'}</h1>
      <Card className="space-y-3">
        <div role="group" aria-label="여행 종류" className="grid grid-cols-2 gap-1 rounded-2xl bg-paper p-1">
          {([[true, '해외 여행'], [false, '국내 여행']] as const).map(([v, l]) => (
            <button key={l} type="button" aria-pressed={abroad === v} onClick={() => chooseTripType(v)}
              className={`rounded-xl py-2.5 text-sm font-semibold ${abroad === v ? 'bg-white text-ink shadow-sm ring-1 ring-line' : 'text-ink-2'}`}>{l}</button>
          ))}
        </div>
        <Field label="여행 이름 *"><input className={input} value={f.name} onChange={set('name')} placeholder={abroad ? '예: 도쿄 3박 4일' : '예: 제주 2박 3일'} /></Field>
        {abroad ? (
          <>
            <Field label="여행지 *"><PlacePicker value={f.timeZone} exclude={[HOME_TZ]} onPick={pickPlace} /></Field>
            <p className="-mt-1 px-1 text-xs text-ink-3">
              국가: {f.country || '정해지지 않음'} · 일정 알림은 현지 시간, 출발 전날 알림은 한국 시간 기준이에요. <button type="button" className="font-semibold text-signal" onClick={() => setEditCountry((v) => !v)}>{editCountry ? '닫기' : '국가 이름 고치기'}</button>
            </p>
            {editCountry && <Field label="국가 (여러 나라를 가면 직접 적어도 돼요)"><input className={input} value={f.country} onChange={set('country')} placeholder="예: 프랑스, 이탈리아" /></Field>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="도시"><input className={input} value={f.city} onChange={set('city')} /></Field>
              <Field label="현지 통화"><select className={input} value={f.localCurrency} onChange={set('localCurrency')}>
                {!CURRENCIES.includes(f.localCurrency) && !otherCurs.includes(f.localCurrency) && <option value={f.localCurrency}>{f.localCurrency}</option>}
                <optgroup label="자주 쓰는 통화">{CURRENCIES.map((c) => <option key={c} value={c}>{c} · {currencyLabel(c)}</option>)}</optgroup>
                {otherCurs.length > 0 && <optgroup label="그 밖의 모든 통화">{otherCurs.map((c) => <option key={c} value={c}>{c}{currencyLabel(c) ? ` · ${currencyLabel(c)}` : ''}</option>)}</optgroup>}
              </select></Field>
            </div>
          </>
        ) : (
          <Field label="지역"><input className={input} value={f.city} onChange={set('city')} placeholder="제주, 부산, 강릉 등" /></Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="시작일 *"><input type="date" className={input} value={f.startDate} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="종료일 *"><input type="date" className={input} value={f.endDate} min={f.startDate || undefined} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        {dateNote && <p className="px-1 text-xs text-danger" role="alert">{dateNote}</p>}
        {!abroad && <p className="px-1 text-xs text-ink-3">국내 여행은 한국 시간과 원화로 설정돼요. 모든 알림은 한국 시간 기준이에요.</p>}
        <Field label="여행 목적"><input className={input} value={f.purpose} onChange={set('purpose')} placeholder="관광, 휴양, 출장 등" /></Field>
        <Field label="동반자 (쉼표로 구분)"><input className={input} value={f.companions} onChange={set('companions')} placeholder="민수, 지은" /></Field>
        {!id && (
          <label className="flex items-center justify-between gap-3 rounded-2xl bg-paper px-4 py-3">
            <span><span className="block text-sm font-semibold">일정 알림 받기</span><span className="block text-xs text-ink-2">끄면 이 여행은 알림 없이 만들어져요. 여행 홈에서 나중에 켤 수 있어요.</span></span>
            <input type="checkbox" className="h-6 w-6 shrink-0 accent-signal" checked={notify} onChange={(e) => setNotify(e.target.checked)} aria-label="일정 알림 받기" />
          </label>
        )}
        <Field label="대표 이미지">
          <input type="file" accept="image/*" className="block w-full min-w-0 text-sm" onChange={(e) => onImage(e.target.files?.[0])} />
          {f.coverImage && <img src={f.coverImage} alt="" className="mt-2 h-32 w-full rounded-xl object-cover" />}
        </Field>
      </Card>
      {err && <p className="rounded-2xl bg-danger/10 p-3 text-sm text-danger" role="alert">{err}</p>}
      <div className="flex gap-2">
        <button className={`${btnGhost} flex-1`} onClick={() => nav(-1)}>취소</button>
        <button className={`${btnPrimary} flex-1`} onClick={submit} disabled={busy}>{id ? '저장' : '여행 만들기'}</button>
      </div>
      {id && (
        <button className="w-full py-3 text-sm text-danger" onClick={async () => {
          if (confirm('이 여행을 삭제할까요? 되돌릴 수 없습니다.')) { await deleteTrip(id); nav('/') }
        }}>여행 삭제</button>
      )}
    </main>
  )
}
