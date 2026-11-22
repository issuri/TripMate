-- 오프라인 동기화: 변경 적용(sync_apply)과 필드 단위 충돌 감지.
--
-- 정책
--  * 클라이언트가 보낸 "바뀐 필드"만 적용한다 → 서로 다른 필드를 동시에 고친 변경은 병합된다.
--  * 같은 필드를 동시에 고친 경우(서버의 필드 버전 > 클라이언트가 본 버전)는 덮어쓰지 않고 충돌로 돌려준다.
--  * 삭제된 행은 되살리지 않는다(삭제 우선). 같은 id로 다시 보내도 중복 생성되지 않는다(멱등).
--  * 이 함수는 SECURITY INVOKER 이므로 모든 권한 검사는 RLS가 그대로 적용한다.

do $$
declare t text;
begin
  foreach t in array array['trips','places','itinerary_items','checklist_items','notes','reservations',
                           'shopping_items','expense_categories','expenses'] loop
    -- 필드별로 "마지막으로 바뀐 행 버전"을 기록한다
    execute format('alter table public.%I add column if not exists field_versions jsonb not null default ''{}''::jsonb', t);
  end loop;
end $$;

create index if not exists places_sync_idx             on public.places (trip_id, updated_at);
create index if not exists itinerary_items_sync_idx    on public.itinerary_items (trip_id, updated_at);
create index if not exists checklist_items_sync_idx    on public.checklist_items (trip_id, updated_at);
create index if not exists shopping_items_sync_idx     on public.shopping_items (trip_id, updated_at);
create index if not exists expense_categories_sync_idx on public.expense_categories (trip_id, updated_at);
create index if not exists expenses_sync_idx           on public.expenses (trip_id, updated_at);

-- p_client: 변경을 보낸 기기의 식별자. 같은 기기가 연속으로 고친 필드는 충돌로 보지 않는다
-- (동기화 도중 같은 필드를 한 번 더 고치면, 방금 내가 올린 값과 "충돌"한 것으로 잘못 판단되기 때문).
-- field_versions 형식: { "필드": { "v": 행 버전, "c": 기기 식별자 } }
create or replace function public.sync_apply(p_table text, p_id uuid, p_op text, p_base_version int, p_fields jsonb, p_client text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  allowed text[] := array['trips','places','itinerary_items','checklist_items','shopping_items','expense_categories','expenses'];
  -- 클라이언트가 바꿀 수 없는 서버 관리 컬럼
  protected text[] := array['id','version','created_at','updated_at','deleted_at','field_versions','trip_id','owner_id','created_by'];
  cur record;
  k text;
  new_version int;
  applied jsonb := '{}'::jsonb;
  conflicts jsonb := '[]'::jsonb;
  set_list text := '';
  fv jsonb;
  cur_json jsonb;
  cols text[];
  n_rows int;
  fv_v int;
  fv_c text;
  norm_json jsonb;
begin
  if not (p_table = any (allowed)) then
    raise exception 'sync_apply: table % is not allowed', p_table using errcode = '22023';
  end if;
  if p_op not in ('upsert', 'delete') then
    raise exception 'sync_apply: bad op %', p_op using errcode = '22023';
  end if;

  select array_agg(column_name::text) into cols
    from information_schema.columns where table_schema = 'public' and table_name = p_table;

  execute format('select to_jsonb(t) from public.%I t where id = $1 for update', p_table) into cur_json using p_id;
  if cur_json is null then
    -- FOR UPDATE 는 UPDATE 권한이 있는 행만 잠근다. 읽을 수는 있지만 고칠 수 없는 행(예: 일반 멤버가 여행 정보를 수정)은
    -- "없는 행"처럼 보이므로, 그대로 두면 삭제가 조용히 성공으로 응답되고 수정은 엉뚱한 INSERT 오류가 된다.
    execute format('select to_jsonb(t) from public.%I t where id = $1', p_table) into cur_json using p_id;
    if cur_json is not null then
      raise exception 'sync_apply: permission denied for % on %', p_op, p_table using errcode = '42501';
    end if;
  end if;

  -- ───── 삭제 ─────
  if p_op = 'delete' then
    if cur_json is null then
      return jsonb_build_object('status', 'ok', 'version', 0, 'note', 'not_found');
    end if;
    if cur_json->>'deleted_at' is null then
      execute format('update public.%I set deleted_at = now() where id = $1', p_table) using p_id;
      get diagnostics n_rows = row_count;
      -- RLS가 행을 걸러내면 오류 없이 0행이 갱신된다: 성공으로 응답하면 클라이언트가 변경이 적용된 줄 안다
      if n_rows = 0 then raise exception 'sync_apply: permission denied for delete on %', p_table using errcode = '42501'; end if;
    end if;
    execute format('select version from public.%I where id = $1', p_table) into new_version using p_id;
    return jsonb_build_object('status', 'ok', 'version', new_version);
  end if;

  -- ───── 신규 생성(같은 id가 이미 있으면 아래 병합 경로로) ─────
  if cur_json is null then
    for k in select jsonb_object_keys(p_fields) loop
      if not (k = any (cols)) then raise exception 'sync_apply: unknown column %', k using errcode = '22023'; end if;
    end loop;
    -- trip_id/owner_id 는 클라이언트가 보낸 값을 쓰되 RLS(with check)가 검증한다.
    -- 보낸 컬럼만 명시해서 넣는다(나머지는 DB 기본값). 서버 관리 컬럼은 무시.
    p_fields := (p_fields - 'version' - 'field_versions' - 'updated_at' - 'created_at' - 'deleted_at') || jsonb_build_object('id', p_id);
    select string_agg(format('%I', key), ', ') into set_list from jsonb_object_keys(p_fields) as key;
    execute format(
      'insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', p_table, set_list, set_list, p_table)
      using p_fields;
    execute format('select version from public.%I where id = $1', p_table) into new_version using p_id;
    return jsonb_build_object('status', 'ok', 'version', new_version, 'created', true);
  end if;

  -- ───── 이미 삭제된 행: 되살리지 않는다 ─────
  if cur_json->>'deleted_at' is not null then
    return jsonb_build_object('status', 'conflict', 'reason', 'deleted', 'version', (cur_json->>'version')::int);
  end if;

  -- ───── 필드 단위 병합 ─────
  fv := coalesce(cur_json->'field_versions', '{}'::jsonb);
  new_version := (cur_json->>'version')::int + 1;
  -- 비교는 컬럼 타입으로 정규화한 값끼리 한다. 같은 시각이어도 서버는 '…+00:00', 클라이언트는 '…Z' 로 적고
  -- time 은 '09:00' 과 '09:00:00' 처럼 표기가 달라, 문자열을 그대로 비교하면 같은 값을 "다르다"고 보고 가짜 충돌을 만든다.
  execute format('select to_jsonb(jsonb_populate_record(null::public.%I, $1))', p_table) into norm_json using p_fields;
  for k in select jsonb_object_keys(p_fields) loop
    if k = any (protected) then continue; end if;
    if not (k = any (cols)) then raise exception 'sync_apply: unknown column %', k using errcode = '22023'; end if;
    -- 서버의 이 필드가 클라이언트가 본 버전보다 나중에, 다른 기기에서 바뀌었고 값이 다르면 충돌
    fv_v := case jsonb_typeof(fv->k) when 'object' then (fv->k->>'v')::int when 'number' then (fv->>k)::int else 1 end;
    fv_c := case when jsonb_typeof(fv->k) = 'object' then fv->k->>'c' end;
    if fv_v > p_base_version and (p_client is null or fv_c is distinct from p_client) and (cur_json->k) is distinct from (norm_json->k) then
      conflicts := conflicts || jsonb_build_array(jsonb_build_object('field', k, 'remote', cur_json->k, 'local', p_fields->k));
    else
      applied := applied || jsonb_build_object(k, p_fields->k);
      set_list := set_list || format('%I = r.%I, ', k, k);
    end if;
  end loop;

  if set_list <> '' then
    execute format(
      'update public.%I t set %s field_versions = t.field_versions || (select jsonb_object_agg(key, jsonb_build_object(''v'', $3::int, ''c'', $4::text)) from jsonb_object_keys($2) as key) '
      'from (select * from jsonb_populate_record(null::public.%I, $2)) r where t.id = $1',
      p_table, set_list, p_table)
      using p_id, applied, new_version, p_client;
    get diagnostics n_rows = row_count;
    if n_rows = 0 then raise exception 'sync_apply: permission denied for update on %', p_table using errcode = '42501'; end if;
    execute format('select version from public.%I where id = $1', p_table) into new_version using p_id;
  else
    new_version := (cur_json->>'version')::int;
  end if;

  return jsonb_build_object(
    'status', case when jsonb_array_length(conflicts) > 0 then 'conflict' else 'ok' end,
    'version', new_version, 'applied', applied, 'conflicts', conflicts);
end $$;

grant execute on function public.sync_apply(text, uuid, text, int, jsonb, text) to authenticated;
