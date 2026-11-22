import { useEffect } from 'react'
import { startAuth, useAuth } from '../sync/auth'
import { startRealtime, syncManager } from '../sync/runtime'

/**
 * 앱이 열려 있는 동안: 로그인 세션 복구, 자동 동기화(인터넷 복구·주기적·변경 직후), 실시간 변경 구독.
 * 서버가 설정/로그인되지 않았으면 아무것도 보내지 않고 로컬 전용으로 동작한다.
 */
export default function SyncHost() {
  const auth = useAuth()
  useEffect(() => { startAuth() }, [])
  useEffect(() => syncManager.start(), [])
  // 로그인 상태가 바뀔 때마다 실시간 구독을 새로 맺는다(로그아웃하면 해제)
  useEffect(() => { const stop = startRealtime(); syncManager.requestSync(500); return stop }, [auth.userId])
  return null
}
