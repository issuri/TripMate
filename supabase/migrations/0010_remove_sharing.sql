-- 0010: 동행자 공유 기능 삭제.
--  * 초대 코드, 참여, 권한 관리, 공유 종료, 표시 이름(프로필)에 쓰이던 함수와 테이블을 지운다.
--  * trip_members 는 남긴다: 여행을 만든 사람이 자동으로 관리자로 들어가고, 모든 행 단위 보안(RLS)이 이 행으로 접근을 판단한다.
--    (직접 쓰기 정책은 0007 에서 이미 없어졌으므로, 이제 여행 소유자 한 명 외에는 멤버가 생길 수 없다.)
--  * 내 기기끼리 동기화(sync_apply)와 경비의 'n:이름' 동반자 정산은 그대로다.

drop function if exists public.create_invite(uuid, int, int);
drop function if exists public.join_trip(text);
drop function if exists public.revoke_invite(uuid);
drop function if exists public.list_members(uuid);
drop function if exists public.set_member_role(uuid, uuid, text);
drop function if exists public.remove_member(uuid, uuid);
drop function if exists public.leave_trip(uuid);
drop function if exists public.end_sharing(uuid);
drop function if exists public.upsert_profile(text);

-- 초대 코드 도우미(다른 곳에서 쓰지 않는다)
drop function if exists public.hash_code(text);
drop function if exists public.norm_code(text);
drop function if exists public.require_auth();

-- 정책은 테이블과 함께 사라진다
drop table if exists public.join_attempts;
drop table if exists public.trip_invites;
drop table if exists public.profiles;
