import { useEffect } from 'react'
import { syncManager } from '../sync/runtime'

/** 앱이 열려 있는 동안 자동 동기화를 돌린다(인터넷 복구 시·주기적·변경 직후). 서버가 설정/로그인되지 않았으면 아무것도 보내지 않는다. */
export default function SyncHost() {
  useEffect(() => syncManager.start(), [])
  return null
}
