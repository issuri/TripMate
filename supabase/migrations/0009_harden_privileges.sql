-- 0009: 권한 최소화
--  * 비로그인(anon)은 어떤 테이블에도 직접 접근하지 못하게 한다(RLS와 별개로 이중 방어).
--  * 멤버 여부를 확인하는 보조 함수는 로그인한 사용자만 실행할 수 있다.
--    (기본값은 모두에게 열려 있어, 비로그인 상태로 "이 사용자가 이 여행의 멤버인가"를 물어볼 수 있었다.)
--  RLS 정책은 호출한 사용자의 권한으로 이 함수들을 부르므로 authenticated 에는 실행 권한을 남긴다.

do $$
declare f text;
begin
  foreach f in array array[
    'is_trip_member(uuid)', 'is_trip_admin(uuid)', 'trip_has_members(uuid)', 'exp_person_ok(uuid,text)',
    'require_auth()', 'norm_code(text)', 'hash_code(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;

  -- Supabase 에는 anon 역할이 있다. 없는 환경(로컬 테스트 등)에서는 건너뛴다.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
    execute 'revoke execute on all functions in schema public from anon';
    -- 앞으로 만들 객체도 anon 에게 자동으로 열리지 않게 한다
    execute 'alter default privileges in schema public revoke all on tables from anon';
    execute 'alter default privileges in schema public revoke all on functions from anon';
  end if;
end $$;
