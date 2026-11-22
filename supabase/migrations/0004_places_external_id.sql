-- 지도 제공자를 Google에서 OpenStreetMap으로 변경: 외부 장소 식별자를 provider 중립 이름으로 변경
-- (값 예: 'node/123456' = OSM 요소). 기존 인덱스도 함께 이름 변경.
alter table public.places rename column google_place_id to external_id;
alter index if exists places_trip_google_uniq rename to places_trip_external_uniq;
