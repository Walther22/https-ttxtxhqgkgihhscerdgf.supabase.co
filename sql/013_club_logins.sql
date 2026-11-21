-- WASRA Member Portal
-- 013: Club logins (a login that can only see ONE club's members)
--
-- How it works
--   * A login with a row in portal_user_scope is "restricted" to that club.
--   * Restricted logins can only read memberT / PaidT rows for their own club,
--     cannot use Practice Sign-In (SignInT), and cannot change member data.
--     They are also given edit access to Notifications (venue issues).
--   * Everyone else (existing logins, administrators) is unchanged.
--   * The rules are RESTRICTIVE row level security policies, so they are
--     enforced by the database no matter what the app shows.
--
-- Run 012_locker_key_registers.sql first (this uses its admin check).
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- Safety checks: restrictive policies only work if row level security is ON.
-- Turning it on blindly could lock everyone out, so stop with a clear message.
-- ---------------------------------------------------------------------------
do $do$
declare
    t text;
begin
    foreach t in array array['memberT', 'PaidT', 'SignInT']
    loop
        if to_regclass(format('public.%I', t)) is null then
            raise exception 'Table public."%" does not exist.', t;
        end if;
        if not (select c.relrowsecurity from pg_class c where c.oid = format('public.%I', t)::regclass) then
            raise exception 'Row level security is OFF on public."%". Club restrictions would not be enforced. Tell Claude before continuing.', t;
        end if;
    end loop;

    if to_regprocedure('public.is_register_admin()') is null then
        raise exception 'Run 012_locker_key_registers.sql first.';
    end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- Which club each restricted login belongs to
-- ---------------------------------------------------------------------------
create table if not exists public.portal_user_scope (
    user_id uuid primary key references auth.users (id) on delete cascade,
    club_no bigint not null,
    created_at timestamptz not null default now()
);

alter table public.portal_user_scope enable row level security;
revoke all on public.portal_user_scope from anon, authenticated;

create or replace function public.portal_my_club()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
    select s.club_no from public.portal_user_scope s where s.user_id = auth.uid()
$$;

revoke all on function public.portal_my_club() from public, anon;
grant execute on function public.portal_my_club() to authenticated;

-- What the app asks after sign in: { restricted, club_no, club_name }
create or replace function public.portal_my_scope()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(
        (select jsonb_build_object(
                    'restricted', true,
                    'club_no', s.club_no,
                    'club_name', (select c."Club_Name" from public."ClubT" c where c."CLUBID" = s.club_no)
                )
         from public.portal_user_scope s
         where s.user_id = auth.uid()),
        jsonb_build_object('restricted', false)
    )
$$;

revoke all on function public.portal_my_scope() from public, anon;
grant execute on function public.portal_my_scope() to authenticated;

-- ---------------------------------------------------------------------------
-- Restrictive row level security
-- ---------------------------------------------------------------------------
-- memberT: restricted logins see only their club and cannot change anything.
drop policy if exists club_login_select on public."memberT";
create policy club_login_select on public."memberT"
    as restrictive for select to authenticated
    using ((select public.portal_my_club()) is null
           or "Club No" = (select public.portal_my_club()));

drop policy if exists club_login_insert on public."memberT";
create policy club_login_insert on public."memberT"
    as restrictive for insert to authenticated
    with check ((select public.portal_my_club()) is null);

drop policy if exists club_login_update on public."memberT";
create policy club_login_update on public."memberT"
    as restrictive for update to authenticated
    using ((select public.portal_my_club()) is null);

drop policy if exists club_login_delete on public."memberT";
create policy club_login_delete on public."memberT"
    as restrictive for delete to authenticated
    using ((select public.portal_my_club()) is null);

-- PaidT: find the column that points at memberT, then limit to the club's members.
do $do$
declare
    v_col text;
begin
    select a.attname
    into v_col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.conrelid = 'public."PaidT"'::regclass
      and c.confrelid = 'public."memberT"'::regclass
      and array_length(c.conkey, 1) = 1
    limit 1;

    if v_col is null then
        raise exception 'Could not find the column linking public."PaidT" to public."memberT". Tell Claude.';
    end if;

    execute 'drop policy if exists club_login_select on public."PaidT"';
    execute format(
        'create policy club_login_select on public."PaidT" as restrictive for select to authenticated '
        'using ((select public.portal_my_club()) is null '
        'or %I in (select m."MEMID" from public."memberT" m where m."Club No" = (select public.portal_my_club())))',
        v_col
    );

    execute 'drop policy if exists club_login_insert on public."PaidT"';
    execute 'create policy club_login_insert on public."PaidT" as restrictive for insert to authenticated '
            'with check ((select public.portal_my_club()) is null)';
    execute 'drop policy if exists club_login_update on public."PaidT"';
    execute 'create policy club_login_update on public."PaidT" as restrictive for update to authenticated '
            'using ((select public.portal_my_club()) is null)';
    execute 'drop policy if exists club_login_delete on public."PaidT"';
    execute 'create policy club_login_delete on public."PaidT" as restrictive for delete to authenticated '
            'using ((select public.portal_my_club()) is null)';
end
$do$;

-- SignInT (Practice Sign-In): not available to restricted logins at all.
drop policy if exists club_login_select on public."SignInT";
create policy club_login_select on public."SignInT"
    as restrictive for select to authenticated
    using ((select public.portal_my_club()) is null);

drop policy if exists club_login_insert on public."SignInT";
create policy club_login_insert on public."SignInT"
    as restrictive for insert to authenticated
    with check ((select public.portal_my_club()) is null);

drop policy if exists club_login_update on public."SignInT";
create policy club_login_update on public."SignInT"
    as restrictive for update to authenticated
    using ((select public.portal_my_club()) is null);

drop policy if exists club_login_delete on public."SignInT";
create policy club_login_delete on public."SignInT"
    as restrictive for delete to authenticated
    using ((select public.portal_my_club()) is null);

-- ---------------------------------------------------------------------------
-- Administrator tools (used by the Register Access screen)
-- ---------------------------------------------------------------------------
create or replace function public.list_club_logins()
returns table (user_id uuid, email text, club_no bigint, club_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not public.is_register_admin() then
        return;
    end if;

    return query
    select s.user_id, u.email::text, s.club_no, c."Club_Name"::text
    from public.portal_user_scope s
    join auth.users u on u.id = s.user_id
    left join public."ClubT" c on c."CLUBID" = s.club_no
    order by c."Club_Name", u.email;
end;
$$;

create or replace function public.set_club_login(p_email text, p_club_no bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid;
begin
    if not public.is_register_admin() then
        return jsonb_build_object('outcome', 'not_authorised', 'message', 'Only an administrator can do this.');
    end if;

    select id into v_user_id from auth.users where lower(email) = lower(btrim(p_email)) limit 1;
    if v_user_id is null then
        return jsonb_build_object('outcome', 'user_not_found',
            'message', 'No login exists for that email. Create the user in Supabase Authentication first.');
    end if;

    if not exists (select 1 from public."ClubT" where "CLUBID" = p_club_no) then
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'That club does not exist.');
    end if;

    if exists (
        select 1 from public.user_profiles up
        where up.user_id = v_user_id and up.role::text = 'admin' and up.is_active
    ) then
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'An administrator cannot be restricted to one club.');
    end if;

    insert into public.portal_user_scope (user_id, club_no)
    values (v_user_id, p_club_no)
    on conflict (user_id) do update set club_no = excluded.club_no;

    -- Club logins can also report notifications (venue issues).
    insert into public.register_access (user_id, register, access_level)
    values (v_user_id, 'issues', 'edit')
    on conflict (user_id, register) do update set access_level = 'edit', updated_at = now();

    return jsonb_build_object('outcome', 'saved', 'message', 'Login restricted to that club. It can also report notifications.');
end;
$$;

create or replace function public.remove_club_login(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not public.is_register_admin() then
        return jsonb_build_object('outcome', 'not_authorised', 'message', 'Only an administrator can do this.');
    end if;

    delete from public.portal_user_scope where user_id = p_user_id;
    return jsonb_build_object('outcome', 'saved', 'message', 'Restriction removed. That login can now see all members.');
end;
$$;

revoke all on function public.list_club_logins() from public, anon;
revoke all on function public.set_club_login(text, bigint) from public, anon;
revoke all on function public.remove_club_login(uuid) from public, anon;
grant execute on function public.list_club_logins() to authenticated;
grant execute on function public.set_club_login(text, bigint) to authenticated;
grant execute on function public.remove_club_login(uuid) to authenticated;

commit;
