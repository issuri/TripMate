-- TripMate 초기 스키마. 모든 동기화 대상 테이블 공통 규칙:
--  * id: 클라이언트가 만드는 UUID (오프라인 생성 + 중복 방지)
--  * version: 서버가 증가시키는 정수 (낙관적 동시성 제어)
--  * deleted_at: soft delete (삭제된 데이터가 재생성되지 않도록 tombstone 유지)
--  * 금액은 모두 정수(최소 통화 단위). 환율은 micro 단위 정수(1 = 0.000001).

-- gen_random_uuid()는 PostgreSQL 13+ 내장 함수라 별도 확장이 필요 없다.

create or replace function public.touch_row() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.version := old.version + 1; end if;
  return new;
end $$;

-- ───────── 여행 ─────────
create table public.trips (
  id uuid primary key,
  owner_id uuid not null references auth.users(id),
  name text not null,
  country text not null default '',
  city text not null default '',
  start_date date not null,
  end_date date not null,
  time_zone text not null default 'Asia/Seoul',   -- 알림은 현지 시간대 기준
  purpose text not null default '',
  cover_image text,
  status text not null default 'planned' check (status in ('planned','ongoing','finished')),
  home_currency text not null default 'KRW',
  local_currency text not null default 'KRW',
  total_budget_minor bigint not null default 0,
  shopping_budget_minor bigint not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (end_date >= start_date)
);

create table public.trip_members (
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('admin','member')),
  display_name text not null default '',
  joined_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

-- 초대 코드: 해시만 저장, 만료/사용횟수 제한
create table public.trip_invites (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  code_hash text not null unique,
  created_by uuid not null references auth.users(id),
  expires_at timestamptz not null,
  max_uses int not null default 10,
  used_count int not null default 0,
  revoked boolean not null default false
);

create or replace function public.is_trip_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members where trip_id = t and user_id = auth.uid());
$$;

create or replace function public.is_trip_admin(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members where trip_id = t and user_id = auth.uid() and role = 'admin');
$$;

-- ───────── 일정 / 장소 ─────────
create table public.places (
  id uuid primary key,
  trip_id uuid not null references public.trips(id) on delete cascade,
  name text not null,
  address text not null default '',
  lat double precision,
  lng double precision,
  google_place_id text,
  category text not null default 'sight',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.itinerary_items (
  id uuid primary key,
  trip_id uuid not null references public.trips(id) on delete cascade,
  day_number int not null check (day_number >= 1),
  sort_order double precision not null default 0,  -- 분수 인덱싱: 순서 변경 시 한 행만 수정
  kind text not null default 'sight' check (kind in ('flight','transit','lodging_in','lodging_out','sight','meal','shopping','airport','other')),
  title text not null,
  start_time time,
  end_time time,
  place_id uuid references public.places(id),
  memo text not null default '',
  travel_minutes int,            -- 이전 일정에서 이동 소요(분)
  travel_mode text,              -- walk | transit | drive
  completed boolean not null default false,
  reminder_enabled boolean not null default true,
  reminder_minutes_before int not null default 30,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on public.itinerary_items (trip_id, day_number, sort_order);

create table public.checklist_items (
  id uuid primary key,
  trip_id uuid not null references public.trips(id) on delete cascade,
  title text not null,
  done boolean not null default false,
  sort_order double precision not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.notes (
  id uuid primary key,
  trip_id uuid not null references public.trips(id) on delete cascade,
  itinerary_item_id uuid references public.itinerary_items(id),
  body text not null default '',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.reservations (
  id uuid primary key,
  trip_id uuid not null references public.trips(id) on delete cascade,
  itinerary_item_id uuid references public.itinerary_items(id),
  title text not null,
  confirmation_ref text not null default '',   -- 민감 정보는 최소한만 저장
  memo text not null default '',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ───────── 쇼핑 ─────────
create table public.shopping_items (
  id uuid primary key,
  trip_id uuid not null references public.trips(id) on delete cascade,
  name text not null,
  quantity int not null default 1 check (quantity >= 1),
  expected_price_minor bigint not null default 0,   -- 예상 가격 (지출로 자동 등록되지 않음)
  currency text not null default 'KRW',
  store_place_id uuid references public.places(id),
  itinerary_item_id uuid references public.itinerary_items(id),
  purchased boolean not null default false,
  expense_id uuid,                                  -- 실제 결제 확인 후 연결된 지출
  memo text not null default '',
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ───────── 경비 ─────────
create table public.expense_categories (
  id uuid primary key,
  trip_id uuid not null references public.trips(id) on delete cascade,
  name text not null,
  budget_minor bigint not null default 0,
  sort_order double precision not null default 0,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.expenses (
  id uuid primary key,   -- 클라이언트 생성 UUID: 재전송해도 중복 등록되지 않음
  trip_id uuid not null references public.trips(id) on delete cascade,
  category_id uuid not null references public.expense_categories(id),
  amount_local_minor bigint not null check (amount_local_minor >= 0),  -- 실제 결제한 현지 통화
  local_currency text not null,
  fx_rate_micro bigint not null default 1000000,                        -- 지출 당시 환율 (1 현지단위 = n 원, ×1e6)
  amount_home_minor bigint not null check (amount_home_minor >= 0),    -- 원화 환산 금액(별도 저장)
  paid_at timestamptz not null default now(),
  payment_method text not null default '',
  payer_id uuid references auth.users(id),
  is_shared boolean not null default false,
  itinerary_item_id uuid references public.itinerary_items(id),
  shopping_item_id uuid references public.shopping_items(id),
  memo text not null default '',
  version int not null default 1,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 공동 경비 참여자별 부담 금액(원화 기준). 합계는 amount_home_minor 와 같아야 한다.
create table public.expense_splits (
  expense_id uuid not null references public.expenses(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  trip_id uuid not null references public.trips(id) on delete cascade,
  share_home_minor bigint not null check (share_home_minor >= 0),
  primary key (expense_id, user_id)
);

-- ───────── 알림 ─────────
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- ───────── 트리거 + RLS ─────────
do $$
declare t text;
begin
  foreach t in array array['trips','places','itinerary_items','checklist_items','notes','reservations',
                           'shopping_items','expense_categories','expenses'] loop
    execute format('create trigger touch before insert or update on public.%I for each row execute function public.touch_row()', t);
  end loop;
end $$;

alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.trip_invites enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.expense_splits enable row level security;

-- 여행 생성자는 자동으로 관리자 멤버가 된다. (RLS상 첫 멤버는 관리자만 추가할 수 있어 트리거가 필요)
create or replace function public.add_owner_as_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.trip_members (trip_id, user_id, role) values (new.id, new.owner_id, 'admin')
  on conflict do nothing;
  return new;
end $$;
create trigger trips_add_owner after insert on public.trips for each row execute function public.add_owner_as_admin();

-- insert ... returning 직후에도 생성자가 자기 여행을 읽을 수 있어야 한다.
create policy trips_select on public.trips for select using (public.is_trip_member(id) or owner_id = auth.uid());
create policy trips_insert on public.trips for insert with check (owner_id = auth.uid());
create policy trips_update on public.trips for update using (public.is_trip_admin(id));
create policy trips_delete on public.trips for delete using (public.is_trip_admin(id));

create policy members_select on public.trip_members for select using (public.is_trip_member(trip_id));
create policy members_admin_write on public.trip_members for all
  using (public.is_trip_admin(trip_id)) with check (public.is_trip_admin(trip_id));
-- 초대 코드 사용(참여)은 별도 RPC(security definer)로만 가능하도록 6단계에서 추가

create policy invites_admin on public.trip_invites for all
  using (public.is_trip_admin(trip_id)) with check (public.is_trip_admin(trip_id));

create policy push_own on public.push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy splits_member on public.expense_splits for all
  using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));

do $$
declare t text;
begin
  foreach t in array array['places','itinerary_items','checklist_items','notes','reservations',
                           'shopping_items','expense_categories','expenses'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy member_all on public.%I for all using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id))', t);
  end loop;
end $$;
