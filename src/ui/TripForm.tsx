import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../db/local'
import { updateTrip } from '../db/itinerary'
import { createTrip, deleteTrip, validateTrip } from '../db/trips'
import { changedFields } from '../lib/diff'
import { btnGhost, btnPrimary, Card, Field, input } from './kit'

const TZ = [['Asia/Seoul', '한국'], ['Asia/Tokyo', '일본'], ['Asia/Bangkok', '태국/베트남'], ['Asia/Taipei', '대만'], ['Asia/Singapore', '싱가포르'],
  ['Europe/Paris', '유럽(서)'], ['Europe/London', '영국'], ['America/New_York', '미국 동부'], ['America/Los_Angeles', '미국 서부'], ['Australia/Sydney', '호주']]
const CUR = ['KRW', 'JPY', 'USD', 'EUR', 'GBP', 'CNY', 'THB', 'TWD', 'VND', 'SGD']

export default function TripForm() {
  const { id } = useParams()
  const nav = useNavigate()
  const existing = useLiveQuery(() => (id ? db.trips.get(id) : undefined), [id])
  const [f, setF] = useState({ name: '', country: '', city: '', startDate: '', endDate: '', timeZone: 'Asia/Seoul', purpose: '', companions: '', localCurrency: 'KRW', coverImage: '' })
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
    }
  }, [existing])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })

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
    const data = {
      name: f.name, country: f.country, city: f.city, startDate: f.startDate, endDate: f.endDate, timeZone: f.timeZone,
      purpose: f.purpose, localCurrency: f.localCurrency,
      companions: f.companions.split(',').map((s) => s.trim()).filter(Boolean), coverImage: f.coverImage || null,
    }
    const v = validateTrip(data)
    if (v) return setErr(v)
    submitting.current = true; setBusy(true)
    try {
      // 수정은 내가 바꾼 필드만 보낸다(폼을 여는 동안 동행자가 고친 다른 필드를 덮어쓰지 않도록)
      if (id) { await updateTrip(id, snapshot.current ? changedFields(snapshot.current, data) : data); nav(`/trips/${id}`) }
      else { const t = await createTrip(data); nav(`/trips/${t.id}`) }
    } catch (e) { setErr((e as Error).message); submitting.current = false; setBusy(false) }
  }

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 pb-10 pt-[calc(1.5rem+env(safe-area-inset-top))]">
      <h1 className="px-1 text-[28px] font-extrabold tracking-tight">{id ? '여행 수정' : '새 여행'}</h1>
      <Card className="space-y-3">
        <Field label="여행 이름 *"><input className={input} value={f.name} onChange={set('name')} placeholder="예: 도쿄 3박 4일" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="국가"><input className={input} value={f.country} onChange={set('country')} /></Field>
          <Field label="도시"><input className={input} value={f.city} onChange={set('city')} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="시작일 *"><input type="date" className={input} value={f.startDate} onChange={set('startDate')} /></Field>
          <Field label="종료일 *"><input type="date" className={input} value={f.endDate} onChange={set('endDate')} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="현지 시간대(알림 기준)"><select className={input} value={f.timeZone} onChange={set('timeZone')}>{TZ.map(([v, l]) => <option key={v} value={v}>{l} ({v})</option>)}</select></Field>
          <Field label="현지 통화"><select className={input} value={f.localCurrency} onChange={set('localCurrency')}>{CUR.map((c) => <option key={c}>{c}</option>)}</select></Field>
        </div>
        <Field label="여행 목적"><input className={input} value={f.purpose} onChange={set('purpose')} placeholder="관광, 휴양, 출장 등" /></Field>
        <Field label="동반자 (쉼표로 구분)"><input className={input} value={f.companions} onChange={set('companions')} placeholder="민수, 지은" /></Field>
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
