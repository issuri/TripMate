import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { addChecklist, byOrder, deleteChecklist, setChecklistDone } from '../db/itinerary'
import { db } from '../db/local'
import type { Trip } from '../db/types'
import { btnPrimary, Card, input } from './kit'

export default function ChecklistPage() {
  const trip = useOutletContext<Trip>()
  const list = (useLiveQuery(() => db.checklistItems.where('tripId').equals(trip.id).filter((c) => !c.deletedAt).toArray(), [trip.id]) ?? []).sort(byOrder)
  const [text, setText] = useState('')
  const done = list.filter((c) => c.done).length
  const add = async () => { if (text.trim()) { await addChecklist(trip.id, text); setText('') } }
  return (
    <div className="space-y-4">
      <div className="px-1">
        <p className="num text-sm text-ink-2">준비 완료 {done}/{list.length}</p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-mint transition-all" style={{ width: `${list.length ? (done / list.length) * 100 : 0}%` }} /></div>
      </div>
      <Card className="divide-y divide-line !p-0">
        {list.length === 0 && <p className="p-6 text-center text-sm text-ink-2">준비물을 추가해 보세요.</p>}
        {list.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-4 py-3.5">
            <input type="checkbox" className="check" checked={c.done} onChange={(e) => setChecklistDone(c.id, e.target.checked)} aria-label={c.title} />
            <span className={`flex-1 text-[15px] ${c.done ? 'text-ink-3 line-through' : ''}`}>{c.title}</span>
            <button className="grid h-8 w-8 place-content-center rounded-full text-ink-3 active:bg-paper" onClick={() => deleteChecklist(c.id)} aria-label="삭제">✕</button>
          </div>
        ))}
      </Card>
      <div className="flex gap-2">
        <input className={input} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="준비물 또는 할 일" />
        <button className={`${btnPrimary} shrink-0`} onClick={add}>추가</button>
      </div>
    </div>
  )
}
