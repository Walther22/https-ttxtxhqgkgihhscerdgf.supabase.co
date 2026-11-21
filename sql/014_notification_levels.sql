-- WASRA Member Portal
-- 014: Notifications (venue issues) get a "report" level
--
--   report = can report an issue (with photo) and see only their OWN reports
--   view   = can see every issue (read only)
--   edit   = can see every issue and ACTION them (in progress / resolved / reopen)
--
-- Only a few people should have edit. Everyone else is set to report.
-- Run after 012 and 013. Safe to run more than once.

begin;

do $do$
begin
    if to_regclass('public.portal_user_scope') is null then
        raise exception 'Run 013_club_logins.sql first.';
    end if;
end
$do$;

-- Allow the new level (report is only valid for the issues area)
do $do$
declare
    c record;
begin
    for c in
        select conname from pg_constraint
        where conrelid = 'public.register_access'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) like '%access_level%'
    loop
        execute format('alter table public.register_access drop constraint %I', c.conname);
    end loop;
end
$do$;

alter table public.register_access
    add constraint register_access_level_check
    check (access_level in ('view', 'edit', 'report')
           and (access_level <> 'report' or register = 'issues'));

-- Issue rules: reporters see only their own reports
drop policy if exists venue_issues_select on public.venue_issues;
create policy venue_issues_select on public.venue_issues
    for select using (
        public.register_access_level('issues') in ('view', 'edit')
        or (public.register_access_level('issues') = 'report' and reported_by = auth.uid())
    );

drop policy if exists venue_issues_insert on public.venue_issues;
create policy venue_issues_insert on public.venue_issues
    for insert with check (
        public.register_access_level('issues') in ('report', 'edit')
        and reported_by = auth.uid()
    );

-- update stays edit-only (set in 012); restated so this file is the full rule set
drop policy if exists venue_issues_update on public.venue_issues;
create policy venue_issues_update on public.venue_issues
    for update using (public.register_access_level('issues') = 'edit')
    with check (public.register_access_level('issues') = 'edit');

create or replace view public.app_venue_issues as
select i.id, i.title, i.description, i.category, i.location, i.priority, i.status,
       i.photo_path, i.created_at, i.resolved_at, i.resolution_notes,
       u.email::text as reported_by_email,
       rp.full_name as reported_by_name,
       rp.club as reported_by_club
from public.venue_issues i
left join auth.users u on u.id = i.reported_by
left join public.register_people rp on rp.user_id = i.reported_by
where public.register_access_level('issues') in ('view', 'edit')
   or (public.register_access_level('issues') = 'report' and i.reported_by = auth.uid());

-- Photos: reporters can upload, and read only the photos of their own reports
drop policy if exists venue_issue_photos_select on storage.objects;
create policy venue_issue_photos_select on storage.objects
    for select to authenticated
    using (
        bucket_id = 'venue-issue-photos'
        and (
            public.register_access_level('issues') in ('view', 'edit')
            or (
                public.register_access_level('issues') = 'report'
                and exists (
                    select 1 from public.venue_issues vi
                    where vi.photo_path = storage.objects.name and vi.reported_by = auth.uid()
                )
            )
        )
    );

drop policy if exists venue_issue_photos_insert on storage.objects;
create policy venue_issue_photos_insert on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'venue-issue-photos'
        and public.register_access_level('issues') in ('report', 'edit')
    );

-- Admin functions that accept the new level
create or replace function public.grant_register_access_by_email(
    p_email text,
    p_full_name text,
    p_club text,
    p_position text,
    p_lockers text default 'none',
    p_keys text default 'none',
    p_issues text default 'none'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid;
    v_register text;
    v_level text;
begin
    if public.current_staff_role() is distinct from 'admin' then
        return jsonb_build_object('outcome', 'not_authorised', 'message', 'Only an administrator can change register access.');
    end if;

    select id into v_user_id from auth.users where lower(email) = lower(btrim(p_email)) limit 1;

    if v_user_id is null then
        return jsonb_build_object(
            'outcome', 'user_not_found',
            'message', 'No login exists for that email. Create the user in Supabase Authentication first, then add them here.'
        );
    end if;

    if p_lockers not in ('none', 'view', 'edit') or p_keys not in ('none', 'view', 'edit') or p_issues not in ('none', 'report', 'view', 'edit') then
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'Access must be none, view or edit (issues can also be report).');
    end if;

    insert into public.register_people (user_id, full_name, club, job_position)
    values (v_user_id, nullif(btrim(coalesce(p_full_name, '')), ''), nullif(btrim(coalesce(p_club, '')), ''), nullif(btrim(coalesce(p_position, '')), ''))
    on conflict (user_id) do update
        set full_name = excluded.full_name, club = excluded.club, job_position = excluded.job_position, updated_at = now();

    for v_register, v_level in
        select * from (values ('lockers', p_lockers), ('keys', p_keys), ('issues', p_issues)) as t(r, l)
    loop
        if v_level = 'none' then
            delete from public.register_access where user_id = v_user_id and register = v_register;
        else
            insert into public.register_access (user_id, register, access_level)
            values (v_user_id, v_register, v_level)
            on conflict (user_id, register)
            do update set access_level = excluded.access_level, updated_at = now();
        end if;
    end loop;

    return jsonb_build_object('outcome', 'saved', 'message', 'Access saved.');
end;
$$;

create or replace function public.set_register_access(
    p_user_id uuid,
    p_register text,
    p_access_level text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
    if public.current_staff_role() is distinct from 'admin' then
        return jsonb_build_object('outcome', 'not_authorised', 'message', 'Only an administrator can change register access.');
    end if;

    if p_register not in ('lockers', 'keys', 'issues') then
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'Unknown register.');
    end if;

    if p_access_level = 'none' then
        delete from public.register_access where user_id = p_user_id and register = p_register;
    elsif p_access_level in ('view', 'edit') or (p_access_level = 'report' and p_register = 'issues') then
        insert into public.register_access (user_id, register, access_level)
        values (p_user_id, p_register, p_access_level)
        on conflict (user_id, register)
        do update set access_level = excluded.access_level, updated_at = now();
    else
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'Access must be none, view or edit (report is only for issues).');
    end if;

    return jsonb_build_object('outcome', 'saved', 'message', 'Access updated.');
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

    -- Club logins can report notifications (venue issues) but not action them.
    -- An existing, higher level (view / edit) is left as it is.
    insert into public.register_access (user_id, register, access_level)
    values (v_user_id, 'issues', 'report')
    on conflict (user_id, register) do nothing;

    return jsonb_build_object('outcome', 'saved', 'message', 'Login restricted to that club. It can also report notifications.');
end;
$$;

-- Club logins set up earlier were given edit; they can only report from now on.
update public.register_access ra
set access_level = 'report', updated_at = now()
where ra.register = 'issues'
  and ra.access_level = 'edit'
  and exists (select 1 from public.portal_user_scope s where s.user_id = ra.user_id);

commit;
