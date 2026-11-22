-- 무결성 강화: 한 여행의 데이터는 같은 여행의 데이터만 참조할 수 있다.
-- (일반 FK는 대상 행이 어느 여행 것인지 확인하지 않아, 다른 여행의 지출 항목/일정/장소를 연결하거나
--  여행 멤버가 아닌 사용자를 결제자·정산 대상으로 넣을 수 있었다.)
-- 복합 FK (trip_id, id)로 "같은 여행"을 강제한다. FK 검사는 RLS를 우회하므로 이 제약이 필요하다.

-- 복합 FK의 대상이 되려면 (trip_id, id) 유니크 제약이 필요하다
alter table public.places             add constraint places_trip_id_uniq             unique (trip_id, id);
alter table public.itinerary_items    add constraint itinerary_items_trip_id_uniq    unique (trip_id, id);
alter table public.shopping_items     add constraint shopping_items_trip_id_uniq     unique (trip_id, id);
alter table public.expense_categories add constraint expense_categories_trip_id_uniq unique (trip_id, id);
alter table public.expenses           add constraint expenses_trip_id_uniq           unique (trip_id, id);

-- itinerary_items.place_id
alter table public.itinerary_items drop constraint itinerary_items_place_id_fkey;
alter table public.itinerary_items add constraint itinerary_items_place_same_trip
  foreign key (trip_id, place_id) references public.places (trip_id, id);

-- shopping_items.store_place_id / itinerary_item_id
alter table public.shopping_items drop constraint shopping_items_store_place_id_fkey;
alter table public.shopping_items add constraint shopping_items_store_same_trip
  foreign key (trip_id, store_place_id) references public.places (trip_id, id);
alter table public.shopping_items drop constraint shopping_items_itinerary_item_id_fkey;
alter table public.shopping_items add constraint shopping_items_itinerary_same_trip
  foreign key (trip_id, itinerary_item_id) references public.itinerary_items (trip_id, id);

-- notes / reservations
alter table public.notes drop constraint notes_itinerary_item_id_fkey;
alter table public.notes add constraint notes_itinerary_same_trip
  foreign key (trip_id, itinerary_item_id) references public.itinerary_items (trip_id, id);
alter table public.reservations drop constraint reservations_itinerary_item_id_fkey;
alter table public.reservations add constraint reservations_itinerary_same_trip
  foreign key (trip_id, itinerary_item_id) references public.itinerary_items (trip_id, id);

-- expenses.category_id / itinerary_item_id / shopping_item_id / payer_id
alter table public.expenses drop constraint expenses_category_id_fkey;
alter table public.expenses add constraint expenses_category_same_trip
  foreign key (trip_id, category_id) references public.expense_categories (trip_id, id);
alter table public.expenses drop constraint expenses_itinerary_item_id_fkey;
alter table public.expenses add constraint expenses_itinerary_same_trip
  foreign key (trip_id, itinerary_item_id) references public.itinerary_items (trip_id, id);
alter table public.expenses drop constraint expenses_shopping_item_id_fkey;
alter table public.expenses add constraint expenses_shopping_same_trip
  foreign key (trip_id, shopping_item_id) references public.shopping_items (trip_id, id);
-- 결제자는 그 여행의 멤버여야 한다 (payer_id가 null이면 검사하지 않음 = MATCH SIMPLE)
alter table public.expenses add constraint expenses_payer_is_member
  foreign key (trip_id, payer_id) references public.trip_members (trip_id, user_id);

-- expense_splits: 분담 행은 해당 지출과 같은 여행이며, 참여자는 그 여행의 멤버여야 한다
alter table public.expense_splits drop constraint expense_splits_expense_id_fkey;
alter table public.expense_splits add constraint expense_splits_expense_same_trip
  foreign key (trip_id, expense_id) references public.expenses (trip_id, id) on delete cascade;
alter table public.expense_splits add constraint expense_splits_user_is_member
  foreign key (trip_id, user_id) references public.trip_members (trip_id, user_id);

-- shopping_items.expense_id는 아직 FK가 없었다: 같은 여행의 지출만 연결
alter table public.shopping_items add constraint shopping_items_expense_same_trip
  foreign key (trip_id, expense_id) references public.expenses (trip_id, id);
