-- 경비: 금액·환율·결제자·분담을 하나의 JSON 필드(money)로 저장한다.
--
-- 왜 하나의 필드인가: 동기화는 "바뀐 필드"만 병합한다. 금액과 분담이 따로 병합되면(한 기기는 금액을, 다른 기기는 분담을 수정)
-- "분담 합계 ≠ 금액"인 지출이 생길 수 있다. money 를 한 덩어리로 두면 충돌도 한 덩어리로 처리되어 항상 일관된다.
--
-- money 형식(모든 금액은 최소 통화 단위 정수, 원화 환산액은 home 통화(KRW) 기준):
--   { localMinor, currency, rateMicro, homeMinor, shared, payer, splits: [{k, s}] }
--   payer/k 는 "사람 키": 계정이 있는 동행자는 사용자 UUID, 계정이 없는 동행자는 'n:이름'.
-- 이 트리거가 형식·합계·멤버 여부를 검증하고, 기존 컬럼(amount_*, fx_rate_micro, is_shared, payer_id)은 money 에서 항상 다시 계산한다.

alter table public.expenses add column if not exists money jsonb;

-- 분담은 money.splits 로 옮겼다
drop table if exists public.expense_splits cascade;
-- 쇼핑 ↔ 지출 연결은 지출 쪽(expenses.shopping_item_id)에서만 한다. 양방향 외래키는 서로를 먼저 올려야 하는 순환이 된다.
alter table public.shopping_items drop constraint if exists shopping_items_expense_same_trip;

-- 사람 키가 이 여행에서 유효한가. UUID 는 지금 참여 중인 멤버여야 한다. (내보내진 사람을 새 지출의 참여자로 넣을 수는 없다.
-- 다만 이미 그 지출에 들어 있던 사람은 계속 유지할 수 있다 — 아래 트리거에서 처리.)
-- SECURITY DEFINER: RLS와 무관하게 멤버 상태를 확인해야 한다.
create or replace function public.exp_person_ok(p_trip uuid, p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then exists (select 1 from public.trip_members where trip_id = p_trip and user_id = p_key::uuid and status = 'active')
    when p_key ~ '^n:.{1,60}$' then true
    else false   -- 'self' 같은 기기 내부 표기는 서버에 올라오면 안 된다
  end
$$;

create or replace function public.expenses_validate() returns trigger
language plpgsql set search_path = public as $$
declare
  m jsonb := new.money;
  el jsonb;
  keys text[] := '{}';
  total bigint := 0;
  k text; s bigint; payer text;
  unchanged boolean := (tg_op = 'UPDATE' and old.money is not distinct from new.money);
  prior text[] := '{}';   -- 이 지출에 원래 들어 있던 사람들(내보내졌어도 기록 유지를 위해 계속 허용)
begin
  -- 작성자는 서버가 정한다(클라이언트가 보낸 값은 무시). 수정해도 바뀌지 않는다.
  if tg_op = 'INSERT' then new.created_by := auth.uid(); else new.created_by := old.created_by; end if;
  if tg_op = 'UPDATE' and old.money is not null then
    select coalesce(array_agg(x), '{}') into prior from (
      select old.money->>'payer' as x
      union all select e->>'k' from jsonb_array_elements(coalesce(old.money->'splits', '[]'::jsonb)) e) t where x is not null;
  end if;
  if m is null or jsonb_typeof(m) <> 'object' then raise exception 'invalid_money: money is required' using errcode = '22023'; end if;
  if coalesce(m->>'localMinor', '') !~ '^[0-9]{1,15}$' or coalesce(m->>'homeMinor', '') !~ '^[0-9]{1,15}$' then
    raise exception 'invalid_money: amounts must be non-negative integers' using errcode = '22023';
  end if;
  if coalesce(m->>'rateMicro', '') !~ '^[1-9][0-9]{0,15}$' then raise exception 'invalid_money: rate must be a positive integer' using errcode = '22023'; end if;
  if coalesce(m->>'currency', '') !~ '^[A-Z]{3}$' then raise exception 'invalid_money: currency' using errcode = '22023'; end if;
  if jsonb_typeof(m->'shared') is distinct from 'boolean' then raise exception 'invalid_money: shared must be boolean' using errcode = '22023'; end if;
  if jsonb_typeof(m->'splits') is distinct from 'array' then raise exception 'invalid_money: splits must be an array' using errcode = '22023'; end if;

  payer := case when jsonb_typeof(m->'payer') = 'string' then m->>'payer' else null end;
  if payer is not null and not unchanged and not (payer = any (prior)) and not public.exp_person_ok(new.trip_id, payer) then
    raise exception 'invalid_money: payer is not a member of this trip' using errcode = '22023';
  end if;

  if (m->>'shared')::boolean then
    if payer is null then raise exception 'invalid_money: shared expense needs a payer' using errcode = '22023'; end if;
    if jsonb_array_length(m->'splits') < 1 then raise exception 'invalid_money: shared expense needs participants' using errcode = '22023'; end if;
    for el in select * from jsonb_array_elements(m->'splits') loop
      if jsonb_typeof(el) <> 'object' or jsonb_typeof(el->'k') <> 'string' or coalesce(el->>'s', '') !~ '^[0-9]{1,15}$' then
        raise exception 'invalid_money: bad split entry' using errcode = '22023';
      end if;
      k := el->>'k'; s := (el->>'s')::bigint;
      if k = any (keys) then raise exception 'invalid_money: duplicate participant' using errcode = '22023'; end if;
      if not unchanged and not (k = any (prior)) and not public.exp_person_ok(new.trip_id, k) then raise exception 'invalid_money: participant is not a member of this trip' using errcode = '22023'; end if;
      keys := keys || k; total := total + s;
    end loop;
    if total <> (m->>'homeMinor')::bigint then raise exception 'invalid_money: shares (%) do not add up to the amount (%)', total, m->>'homeMinor' using errcode = '22023'; end if;
  elsif jsonb_array_length(m->'splits') <> 0 then
    raise exception 'invalid_money: personal expense must not have splits' using errcode = '22023';
  end if;

  -- 이미 공유된 지출을 개인 경비로 바꾸면 다른 멤버에게 갑자기 보이지 않게 되어(RLS) 그들의 화면에는 낡은 사본이 정산에 남는다.
  -- 그래서 금지한다. 개인 경비로 바꾸려면 삭제(모든 멤버에게 전달됨)하고 개인 경비로 새로 등록한다.
  if tg_op = 'UPDATE' and old.is_shared and not (m->>'shared')::boolean then
    raise exception 'invalid_money: a shared expense cannot become personal; delete it and add a personal expense' using errcode = '22023';
  end if;

  -- 기존 컬럼은 항상 money 에서 다시 계산한다(클라이언트가 따로 바꿔도 어긋나지 않게)
  new.amount_local_minor := (m->>'localMinor')::bigint;
  new.local_currency := m->>'currency';
  new.fx_rate_micro := (m->>'rateMicro')::bigint;
  new.amount_home_minor := (m->>'homeMinor')::bigint;
  new.is_shared := (m->>'shared')::boolean;
  new.payer_id := case when payer ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then payer::uuid else null end;
  return new;
end $$;

drop trigger if exists expenses_validate on public.expenses;
create trigger expenses_validate before insert or update on public.expenses for each row execute function public.expenses_validate();

-- ───────── 개인 경비는 작성자만 볼 수 있다 ─────────
-- 공동 경비는 참여 중인 모든 멤버가 보고 고칠 수 있다. 개인 경비(공유하지 않은 지출)는 같은 여행의 다른 멤버에게도 보이지 않는다.
-- 또 다른 멤버가 남의 공동 경비를 "개인 경비"로 바꿔 사실상 숨겨버릴 수 없도록 수정 후에도 같은 조건을 확인한다.
drop policy if exists member_all on public.expenses;
create policy expenses_select on public.expenses for select using (public.is_trip_member(trip_id) and (is_shared or created_by = auth.uid()));
create policy expenses_insert on public.expenses for insert with check (public.is_trip_member(trip_id));
create policy expenses_update on public.expenses for update
  using (public.is_trip_member(trip_id) and (is_shared or created_by = auth.uid()))
  with check (public.is_trip_member(trip_id) and (is_shared or created_by = auth.uid()));
create policy expenses_delete on public.expenses for delete using (public.is_trip_member(trip_id) and (is_shared or created_by = auth.uid()));
