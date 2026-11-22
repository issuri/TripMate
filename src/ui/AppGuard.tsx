import { Component, useEffect, useState, type ReactNode } from 'react'
import { db } from '../db/local'

function Notice({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <main className="mx-auto max-w-md p-6 pt-[calc(4rem+env(safe-area-inset-top))] text-center">
      <h1 className="text-xl font-extrabold">{title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-2">{body}</p>
      {action}
    </main>
  )
}

/** 렌더링 중 예외가 나도 빈 화면 대신 안내를 보여주고, 데이터는 건드리지 않는다. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) { console.error('화면 오류', error instanceof Error ? error.message : 'unknown') } // 개인정보가 섞일 수 있는 상세 내용은 출력하지 않음
  render() {
    if (!this.state.failed) return this.props.children
    return <Notice title="문제가 발생했어요" body="저장된 여행 데이터는 그대로예요. 앱을 새로고침해 주세요."
      action={<button className="mt-6 rounded-2xl bg-ink px-6 py-3.5 font-semibold text-white" onClick={() => location.reload()}>새로고침</button>} />
  }
}

/** 로컬 DB(IndexedDB)를 쓸 수 없는 환경(사생활 보호 모드, 저장소 차단 등)을 미리 감지한다. */
export function DbGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'ok' | 'failed'>('checking')
  useEffect(() => {
    let alive = true
    db.open().then(() => alive && setState('ok'), () => alive && setState('failed'))
    // 용량 부족으로 브라우저가 데이터를 지우지 않도록 영구 저장 요청(지원하는 환경만)
    navigator.storage?.persist?.().catch(() => undefined)
    return () => { alive = false }
  }, [])
  if (state === 'checking') return null
  if (state === 'failed') return <Notice title="저장소를 사용할 수 없어요" body="이 브라우저에서 앱 데이터를 저장할 수 없어요. 사생활 보호 모드를 끄거나, 사이트 데이터 차단 설정을 확인한 뒤 다시 열어 주세요." />
  return <>{children}</>
}
