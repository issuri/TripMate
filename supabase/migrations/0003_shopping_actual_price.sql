-- 쇼핑: 사용자가 실제 결제 금액을 확인한 뒤 입력하는 값. 예상 가격(expected_price_minor)과 분리하며,
-- 예상 가격은 어떤 경우에도 지출로 자동 등록되지 않는다. (금액은 여행 현지 통화 기준 정수)
alter table public.shopping_items add column if not exists actual_price_minor bigint;
alter table public.shopping_items add constraint shopping_actual_nonneg check (actual_price_minor is null or actual_price_minor >= 0);
-- 같은 여행에서 같은 Google 장소가 중복 저장되지 않도록
create unique index if not exists places_trip_google_uniq on public.places (trip_id, google_place_id) where google_place_id is not null and deleted_at is null;
