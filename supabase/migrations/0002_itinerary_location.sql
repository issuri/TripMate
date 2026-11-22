-- 장소 연동(3단계) 전까지 일정에 쓸 수 있는 자유 입력 장소명, 여행 동반자 표시 이름
alter table public.itinerary_items add column if not exists location_text text not null default '';
alter table public.trips add column if not exists companions text[] not null default '{}';
