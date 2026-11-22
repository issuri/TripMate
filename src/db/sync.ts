import type { TripMateDB } from './local'

export const pending = () => ({ updatedAt: Date.now(), syncState: 'pending' as const })

/** 서버 테이블 이름 기준으로 오프라인 변경 큐에 기록 */
// 서버 테이블 이름 목록: expenses, expense_categories 포함 (engine 의 ENTITIES 와 같아야 한다)
export const logChange = (db: TripMateDB, serverTable: string, recordId: string, op: 'upsert' | 'delete', baseVersion: number, fields: string[]) =>
  db.outbox.add({ table: serverTable, recordId, op, baseVersion, changedFields: fields, createdAt: Date.now() })
