import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { db } from '../db/local'
import type { Trip } from '../db/types'
import { pendingCount } from '../sync/engine'
import { useSyncState } from '../sync/runtime'
import { Card } from './kit'

/** 여행 홈의 오프라인 저장 상태 요약 (자세한 관리는 오프라인 저장 화면) */
export default function OfflineSummary({ trip }: { trip: Trip }) {
  const sync = useSyncState()
  const [online, setOnline] = useState(navigator.onLine)
  const meta = useLiveQuery(() => db.syncMeta.get(trip.id), [trip.id])
  const pending = useLiveQuery(() => pendingCount(trip.id), [trip.id, sync.lastReport]) ?? 0
  const conflicts = useLiveQuery(() => db.conflicts.where('tripId').equals(trip.id).count(), [trip.id]) ?? 0
  useEffect(() => {
    const u = () => setOnline(navigator.onLine)
    addEventListener('online', u); addEventListener('offline', u)
    return () => { removeEventListener('online', u); removeEventListener('offline', u) }
  }, [])
  const line = conflicts ? `확인할 충돌 ${conflicts}건` : !sync.configured ? '이 기기에 저장됨 · 서버 미설정' : pending ? `동기화 대기 ${pending}건` : meta?.lastSyncAt ? '서버와 동기화됨' : '아직 서버에 올리지 않음'
  return (
    <Link to={`/trips/${trip.id}/offline`} className="block">
      <Card className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold">오프라인 저장</h2>
          <p className={`mt-0.5 truncate text-sm ${conflicts ? 'font-semibold text-coral' : 'text-ink-2'}`}>{line}</p>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${online ? 'bg-mint/15 text-mint' : 'bg-line text-ink-2'}`}>{online ? '온라인' : '오프라인'}</span>
      </Card>
    </Link>
  )
}
