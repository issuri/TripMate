import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { db } from '../db/local'
import type { Trip } from '../db/types'
import { MAX_ATTEMPTS } from '../sync/engine'
import { useSyncState } from '../sync/runtime'
import { Card } from './kit'

/**
 * 여행 홈의 동기화 알림. 평소에는 아무것도 보이지 않고, 사용자가 직접 처리해야 할 일이 있을 때만 나타난다:
 *  - 내 다른 기기와 같은 항목을 동시에 고쳐서 생긴 충돌
 *  - 서버가 여러 번 거부해서 더 이상 올라가지 않는 변경
 * 오프라인 저장 화면(전체 내려받기, 이 기기의 사본 삭제 등)은 여행 화면 위쪽의 "동기화" 버튼으로 들어간다(서버를 쓸 때).
 */
export default function OfflineSummary({ trip }: { trip: Trip }) {
  const sync = useSyncState()
  const conflicts = useLiveQuery(() => db.conflicts.where('tripId').equals(trip.id).count(), [trip.id]) ?? 0
  const stuck = useLiveQuery(async () => (await db.outbox.toArray()).filter((e) => (e.attempts ?? 0) >= MAX_ATTEMPTS).length, []) ?? 0
  const rejected = sync.configured ? stuck : 0                    // 서버를 쓰지 않으면 해당 없음
  if (!conflicts && !rejected) return null
  return (
    <Link to={`/trips/${trip.id}/offline`} className="block">
      <Card className="flex items-center justify-between gap-3 ring-1 ring-coral/40">
        <div className="min-w-0">
          <h2 className="text-base font-bold">확인이 필요해요</h2>
          <p className="mt-0.5 text-sm font-semibold text-coral">
            {conflicts ? `다른 기기와 같은 항목을 고쳐서 충돌 ${conflicts}건이 생겼어요` : `서버가 받지 못한 변경 ${rejected}건이 있어요`}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-coral px-3 py-1 text-xs font-bold text-white">처리하기</span>
      </Card>
    </Link>
  )
}
