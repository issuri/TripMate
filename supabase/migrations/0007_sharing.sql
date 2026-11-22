-- 동행자 공유: 초대 코드, 참여, 멤버·권한 관리.
--
-- 원칙
--  * 여행 정보는 "참여 중(active)인 멤버"만 읽고 쓴다. URL/코드를 안다는 사실만으로는 접근할 수 없다(로그인 + 초대 코드 사용 필요).
--  * 멤버/초대 테이블은 직접 쓰기를 모두 막고, 아래 RPC(SECURITY DEFINER)로만 바꾼다 → 권한 검사를 한 곳에 모은다.
--  * 멤버를 삭제하지 않고 status 로 표시한다(탈퇴/내보내기). 지출의 결제자·정산 대상으로 이미 참조 중인 사람을
--    지울 수 없기 때문이고, 과거 정산 기록도 보존해야 하기 때문이다.
--  * 초대 코드는 평문을 저장하지 않는다(해시만). 만료·사용 횟수·취소·시도 횟수 제한이 있다.

alter table public.trip_members add column if not exists status text not null default 'active' check (status in ('active', 'left', 'removed'));
alter table public.trip_members add column if not exists left_at timestamptz;
alter table public.trip_members add column if not exists invited_by uuid references auth.users(id);

-- 참여 중인 멤버만 접근 권한이 있다 (탈퇴·내보내기 즉시 모든 RLS 정책에서 접근이 막힌다)
create or replace function public.is_trip_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members where trip_id = t and user_id = auth.uid() and status = 'active');
$$;
create or replace function public.is_trip_admin(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members where trip_id = t and user_id = auth.uid() and role = 'admin' and status = 'active');
$$;

-- 소유자 예외는 "아직 멤버 행이 하나도 없는 생성 직후"에만 적용한다. 그렇지 않으면 다른 관리자에게 내보내진 원래 소유자가
-- 여행 행을 계속 읽게 되어(접근 상실을 감지하지 못하고) 일관성이 깨진다. (insert ... returning 직후 읽기를 위해 필요했던 예외)
-- (정책 안에서 trip_members 를 직접 조회하면 RLS가 적용되어 내보내진 소유자에게는 행이 안 보여 "멤버 없음"으로 잘못 판단한다 → 정의자 권한 함수 사용)
create or replace function public.trip_has_members(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members where trip_id = t);
$$;
drop policy if exists trips_select on public.trips;
create policy trips_select on public.trips for select using (
  public.is_trip_member(id) or (owner_id = auth.uid() and not public.trip_has_members(id)));

-- 멤버/초대는 직접 쓰기 금지(조회만). 변경은 RPC로만.
drop policy if exists members_admin_write on public.trip_members;
drop policy if exists invites_admin on public.trip_invites;
create policy invites_admin_read on public.trip_invites for select using (public.is_trip_admin(trip_id));

alter table public.trip_invites add column if not exists created_at timestamptz not null default now();

-- ───────── 프로필(표시 이름) ─────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 50),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy profiles_self on public.profiles for all using (id = auth.uid()) with check (id = auth.uid());
-- 같은 여행에 참여 중인 사람의 이름만 볼 수 있다
create policy profiles_comembers on public.profiles for select using (
  exists (select 1 from public.trip_members a join public.trip_members b on a.trip_id = b.trip_id
          where a.user_id = auth.uid() and a.status = 'active' and b.user_id = profiles.id and b.status = 'active'));

-- ───────── 초대 코드 시도 기록(무차별 대입 방지) ─────────
create table if not exists public.join_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  at timestamptz not null default now()
);
alter table public.join_attempts enable row level security; -- 정책 없음 = 직접 접근 불가(RPC만 사용)

-- ───────── 도우미 ─────────
create or replace function public.norm_code(p text) returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '[^0-9A-Za-z]', '', 'g'))
$$;
create or replace function public.hash_code(p text) returns text language sql immutable as $$
  select encode(sha256(convert_to(public.norm_code(p), 'UTF8')), 'hex')
$$;

create or replace function public.require_auth() returns uuid language plpgsql stable as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return auth.uid();
end $$;

-- ───────── 초대 만들기 (관리자) ─────────
create or replace function public.create_invite(p_trip uuid, p_expires_hours int default 168, p_max_uses int default 5)
returns text language plpgsql security definer set search_path = public as $$
declare raw text; code text; tries int := 0;
begin
  perform public.require_auth();
  if not public.is_trip_admin(p_trip) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_expires_hours < 1 or p_expires_hours > 720 or p_max_uses < 1 or p_max_uses > 50 then raise exception 'invalid_argument' using errcode = '22023'; end if;
  if (select count(*) from public.trip_invites where trip_id = p_trip and not revoked and expires_at > now() and used_count < max_uses) >= 20 then
    raise exception 'too_many_invites' using errcode = 'P0001';
  end if;
  loop
    raw := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));   -- 48비트 무작위(uuid v4)
    code := substr(raw, 1, 4) || '-' || substr(raw, 5, 4) || '-' || substr(raw, 9, 4);
    begin
      insert into public.trip_invites (trip_id, code_hash, created_by, expires_at, max_uses)
      values (p_trip, public.hash_code(code), auth.uid(), now() + make_interval(hours => p_expires_hours), p_max_uses);
      return code;   -- 평문 코드는 이 응답에서만 볼 수 있다(저장하지 않음)
    exception when unique_violation then
      tries := tries + 1; if tries > 5 then raise; end if;
    end;
  end loop;
end $$;

-- ───────── 참여 ─────────
-- 실패를 예외로 던지면 트랜잭션이 롤백되어 "실패 시도 기록"이 사라지므로, 실패는 결과값으로 돌려준다.
create or replace function public.join_trip(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public.require_auth(); inv record; fails int; existing record;
begin
  delete from public.join_attempts where at < now() - interval '1 day';
  select count(*) into fails from public.join_attempts where user_id = uid and at > now() - interval '10 minutes';
  if fails >= 8 then return jsonb_build_object('status', 'error', 'code', 'too_many_attempts'); end if;

  select * into inv from public.trip_invites where code_hash = public.hash_code(p_code) for update;
  if not found or inv.revoked or inv.expires_at <= now() or inv.used_count >= inv.max_uses
     or not exists (select 1 from public.trips t where t.id = inv.trip_id and t.deleted_at is null) then
    insert into public.join_attempts (user_id) values (uid);
    -- 코드가 없는지/만료됐는지/소진됐는지 구분하지 않는다(코드 존재 여부를 알려주지 않기 위해)
    return jsonb_build_object('status', 'error', 'code', 'invalid_invite');
  end if;

  select * into existing from public.trip_members where trip_id = inv.trip_id and user_id = uid;
  if found and existing.status = 'active' then
    return jsonb_build_object('status', 'ok', 'trip_id', inv.trip_id, 'already', true);   -- 이미 참여 중: 코드를 소모하지 않는다
  end if;

  insert into public.trip_members (trip_id, user_id, role, status, invited_by)
  values (inv.trip_id, uid, 'member', 'active', inv.created_by)
  on conflict (trip_id, user_id) do update set status = 'active', role = 'member', left_at = null, joined_at = now(), invited_by = excluded.invited_by;
  update public.trip_invites set used_count = used_count + 1 where id = inv.id;
  return jsonb_build_object('status', 'ok', 'trip_id', inv.trip_id);
end $$;

-- ───────── 초대 취소 / 목록 ─────────
create or replace function public.revoke_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  perform public.require_auth();
  select trip_id into t from public.trip_invites where id = p_invite;
  if t is null or not public.is_trip_admin(t) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.trip_invites set revoked = true where id = p_invite;
end $$;

-- ───────── 멤버 목록 ─────────
create or replace function public.list_members(p_trip uuid)
returns table (user_id uuid, display_name text, role text, status text, joined_at timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_auth();
  if not public.is_trip_member(p_trip) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select m.user_id, coalesce(p.display_name, ''), m.role, m.status, m.joined_at, (m.user_id = auth.uid())
    from public.trip_members m left join public.profiles p on p.id = m.user_id
    where m.trip_id = p_trip and (m.status = 'active' or public.is_trip_admin(p_trip))   -- 탈퇴/내보낸 사람은 관리자만 본다
    order by (m.status = 'active') desc, (m.role = 'admin') desc, m.joined_at;
end $$;

-- ───────── 권한 변경 / 내보내기 / 탈퇴 / 공유 종료 ─────────
create or replace function public.set_member_role(p_trip uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare cur record;
begin
  perform public.require_auth();
  if not public.is_trip_admin(p_trip) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_role not in ('admin', 'member') then raise exception 'invalid_argument' using errcode = '22023'; end if;
  select * into cur from public.trip_members where trip_id = p_trip and user_id = p_user and status = 'active' for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if cur.role = 'admin' and p_role = 'member'
     and (select count(*) from public.trip_members where trip_id = p_trip and role = 'admin' and status = 'active') <= 1 then
    raise exception 'last_admin' using errcode = 'P0001';   -- 관리자가 한 명도 없는 여행이 생기지 않게
  end if;
  update public.trip_members set role = p_role where trip_id = p_trip and user_id = p_user;
end $$;

create or replace function public.remove_member(p_trip uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_auth();
  if not public.is_trip_admin(p_trip) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'use_leave' using errcode = 'P0001'; end if;
  update public.trip_members set status = 'removed', left_at = now() where trip_id = p_trip and user_id = p_user and status = 'active';
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
end $$;

create or replace function public.leave_trip(p_trip uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me record;
begin
  perform public.require_auth();
  select * into me from public.trip_members where trip_id = p_trip and user_id = auth.uid() and status = 'active' for update;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  if me.role = 'admin' and (select count(*) from public.trip_members where trip_id = p_trip and role = 'admin' and status = 'active') <= 1 then
    raise exception 'last_admin' using errcode = 'P0001';
  end if;
  update public.trip_members set status = 'left', left_at = now() where trip_id = p_trip and user_id = auth.uid();
end $$;

-- 공유 종료: 나를 뺀 모든 멤버를 내보내고 모든 초대를 취소한다(여행은 나만 남아 비공개가 된다)
create or replace function public.end_sharing(p_trip uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.require_auth();
  if not public.is_trip_admin(p_trip) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.trip_members set status = 'removed', left_at = now() where trip_id = p_trip and user_id <> auth.uid() and status = 'active';
  get diagnostics n = row_count;
  update public.trip_invites set revoked = true where trip_id = p_trip and not revoked;
  return n;
end $$;

create or replace function public.upsert_profile(p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := public.require_auth();
begin
  if char_length(trim(coalesce(p_name, ''))) > 50 then raise exception 'invalid_argument' using errcode = '22023'; end if;
  insert into public.profiles (id, display_name) values (uid, trim(coalesce(p_name, '')))
  on conflict (id) do update set display_name = excluded.display_name, updated_at = now();
end $$;

-- 로그인한 사용자만 실행(기본으로 모두에게 열려 있는 실행 권한을 회수)
do $$
declare f text;
begin
  foreach f in array array[
    'create_invite(uuid,int,int)', 'join_trip(text)', 'revoke_invite(uuid)', 'list_members(uuid)', 'set_member_role(uuid,uuid,text)',
    'remove_member(uuid,uuid)', 'leave_trip(uuid)', 'end_sharing(uuid)', 'upsert_profile(text)', 'sync_apply(text,uuid,text,int,jsonb,text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- 실시간 동기화: 다른 사람의 변경을 알림으로 받는다(RLS가 그대로 적용되어 멤버만 받는다). Supabase 환경에서만 존재.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['trips','places','itinerary_items','checklist_items','shopping_items','expense_categories','expenses','trip_members'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null;
      end;
    end loop;
  end if;
end $$;
