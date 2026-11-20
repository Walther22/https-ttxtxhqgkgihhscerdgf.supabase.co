-- WASRA Sign-On
-- 012: Locker register, key register and venue issue notifications
--
-- Access model: each register (lockers, keys) has its own access list.
--   admin            -> always full (edit) access to lockers, keys and issues
--   anyone else      -> only what is granted in public.register_access (they need
--                       a login but do NOT need to be sign-in staff, so nominated
--                       people from other clubs can report issues)
--                       ('view' = read only, 'edit' = assign/return/add items)
-- Writes to assignments go through the functions below so that an item can
-- only ever have one open assignment and every change stays in the history.

begin;

-- Members lookup. If there is no public.members, build a read-only view over
-- the existing public."memberT" table. MEMID is used as the WASRA number.
-- The view is not exposed to app users directly; only the register views and
-- functions below read it.
do $do$
begin
    if to_regclass('public.members') is null then
        if to_regclass('public."memberT"') is null then
            raise exception 'Neither public.members nor public."memberT" exists. Create the members table first.';
        end if;

        create view public.members as
        select
            "MEMID"::bigint as id,
            "MEMID"::bigint as wasra_number,
            "Given Name" as first_name,
            "Surname" as surname,
            "Mid_Nam" as middle_name,
            "Club No" as club_no,
            true as is_active
        from public."memberT";

        revoke all on public.members from public, anon, authenticated;
    end if;
end
$do$;

-- Staff roles table used by the sign-in app. Created only if missing.
-- role is typically admin, organiser or sign_in.
do $do$
begin
    if to_regclass('public.user_profiles') is null then
        create table public.user_profiles (
            user_id uuid primary key references auth.users (id) on delete cascade,
            role text not null,
            is_active boolean not null default true,
            created_at timestamptz not null default now()
        );

        alter table public.user_profiles enable row level security;

        -- Signed-in people can read their own profile (the app does this on every page).
        create policy user_profiles_select_own on public.user_profiles
            for select to authenticated
            using (user_id = auth.uid());

        grant select on public.user_profiles to authenticated;
    end if;
end
$do$;

-- Helper used by the access rules below. Created only if your database does
-- not already have it. Returns the signed-in person's staff role (admin,
-- organiser, ...) from public.user_profiles, or null if they are not active staff.
do $do$
begin
    if to_regprocedure('public.current_staff_role()') is null then
        execute $fn$
            create function public.current_staff_role()
            returns text
            language sql
            stable
            security definer
            set search_path = ''
            as $body$
                select up.role::text
                from public.user_profiles up
                where up.user_id = auth.uid()
                  and up.is_active
                limit 1
            $body$
        $fn$;
        revoke all on function public.current_staff_role() from public, anon;
        grant execute on function public.current_staff_role() to authenticated;
    end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- Access list
-- ---------------------------------------------------------------------------
create table if not exists public.register_access (
    user_id uuid not null references auth.users (id) on delete cascade,
    register text not null check (register in ('lockers', 'keys', 'issues')),
    access_level text not null check (access_level in ('view', 'edit')),
    updated_at timestamptz not null default now(),
    primary key (user_id, register)
);

alter table public.register_access enable row level security;

create or replace function public.register_access_level(p_register text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_level text;
begin
    if auth.uid() is null then
        return null;
    end if;

    -- Administrators always have full access.
    if public.current_staff_role() = 'admin' then
        return 'edit';
    end if;

    -- Everyone else (staff or not, e.g. a nominated person from another
    -- club) only has what an administrator has granted them.
    select ra.access_level
    into v_level
    from public.register_access ra
    where ra.user_id = auth.uid()
      and ra.register = p_register;

    return v_level;
end;
$$;

-- Who each person is (the register access list shows this)
create table if not exists public.register_people (
    user_id uuid primary key references auth.users (id) on delete cascade,
    full_name text,
    club text,
    job_position text,
    updated_at timestamptz not null default now()
);

alter table public.register_people enable row level security;

drop policy if exists register_people_admin_all on public.register_people;
create policy register_people_admin_all on public.register_people
    for all
    using (public.current_staff_role() = 'admin')
    with check (public.current_staff_role() = 'admin');

-- True when the signed-in person is an administrator (used by the app to show the access screen).
create or replace function public.is_register_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(public.current_staff_role() = 'admin', false)
$$;

drop policy if exists register_access_admin_all on public.register_access;
create policy register_access_admin_all on public.register_access
    for all
    using (public.current_staff_role() = 'admin')
    with check (public.current_staff_role() = 'admin');

-- ---------------------------------------------------------------------------
-- Lockers
-- ---------------------------------------------------------------------------
create table if not exists public.lockers (
    id bigint generated by default as identity primary key,
    locker_number text not null unique,
    location text,
    notes text,
    is_active boolean not null default true,
    created_at timestamptz not null default now()
);

create table if not exists public.locker_assignments (
    id bigint generated by default as identity primary key,
    locker_id bigint not null references public.lockers (id),
    member_id bigint, -- members.id (no foreign key so it also works with a view over memberT)
    holder_name text,
    assigned_on date not null default current_date,
    returned_on date,
    notes text,
    assigned_by uuid default auth.uid(),
    returned_by uuid,
    created_at timestamptz not null default now(),
    check (member_id is not null or nullif(btrim(holder_name), '') is not null),
    check (returned_on is null or returned_on >= assigned_on)
);

create unique index if not exists locker_assignments_one_open
    on public.locker_assignments (locker_id)
    where returned_on is null;

alter table public.lockers enable row level security;
alter table public.locker_assignments enable row level security;

drop policy if exists lockers_select on public.lockers;
create policy lockers_select on public.lockers
    for select using (public.register_access_level('lockers') is not null);

drop policy if exists lockers_insert on public.lockers;
create policy lockers_insert on public.lockers
    for insert with check (public.register_access_level('lockers') = 'edit');

drop policy if exists lockers_update on public.lockers;
create policy lockers_update on public.lockers
    for update using (public.register_access_level('lockers') = 'edit')
    with check (public.register_access_level('lockers') = 'edit');

drop policy if exists locker_assignments_select on public.locker_assignments;
create policy locker_assignments_select on public.locker_assignments
    for select using (public.register_access_level('lockers') is not null);

-- ---------------------------------------------------------------------------
-- Keys
-- ---------------------------------------------------------------------------
create table if not exists public.register_keys (
    id bigint generated by default as identity primary key,
    key_type text not null,
    key_number text not null,
    description text,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    unique (key_type, key_number)
);

create table if not exists public.key_assignments (
    id bigint generated by default as identity primary key,
    key_id bigint not null references public.register_keys (id),
    member_id bigint, -- members.id (no foreign key so it also works with a view over memberT)
    holder_name text,
    assigned_on date not null default current_date,
    returned_on date,
    deposit_amount numeric(8, 2),
    condition text,
    notes text,
    assigned_by uuid default auth.uid(),
    returned_by uuid,
    created_at timestamptz not null default now(),
    check (member_id is not null or nullif(btrim(holder_name), '') is not null),
    check (returned_on is null or returned_on >= assigned_on)
);

create unique index if not exists key_assignments_one_open
    on public.key_assignments (key_id)
    where returned_on is null;

alter table public.register_keys enable row level security;
alter table public.key_assignments enable row level security;

drop policy if exists register_keys_select on public.register_keys;
create policy register_keys_select on public.register_keys
    for select using (public.register_access_level('keys') is not null);

drop policy if exists register_keys_insert on public.register_keys;
create policy register_keys_insert on public.register_keys
    for insert with check (public.register_access_level('keys') = 'edit');

drop policy if exists register_keys_update on public.register_keys;
create policy register_keys_update on public.register_keys
    for update using (public.register_access_level('keys') = 'edit')
    with check (public.register_access_level('keys') = 'edit');

drop policy if exists key_assignments_select on public.key_assignments;
create policy key_assignments_select on public.key_assignments
    for select using (public.register_access_level('keys') is not null);

-- ---------------------------------------------------------------------------
-- Read views (one row per item with its current holder, and full history).
-- They run as the view owner so staff do not need direct read access to the
-- members table, and are gated by register_access_level().
-- ---------------------------------------------------------------------------
create or replace view public.app_locker_register as
select
    l.id as item_id,
    l.locker_number as item_number,
    l.location as item_group,
    l.notes as item_notes,
    l.is_active,
    a.id as assignment_id,
    m.wasra_number,
    coalesce(
        nullif(btrim(concat_ws(' ', m.first_name, m.surname)), ''),
        a.holder_name
    ) as holder_name,
    a.assigned_on,
    a.notes as assignment_notes,
    null::numeric as deposit_amount,
    null::text as condition
from public.lockers l
left join public.locker_assignments a
    on a.locker_id = l.id and a.returned_on is null
left join public.members m on m.id = a.member_id
where public.register_access_level('lockers') is not null;

create or replace view public.app_locker_history as
select
    a.locker_id as item_id,
    a.id as assignment_id,
    m.wasra_number,
    coalesce(
        nullif(btrim(concat_ws(' ', m.first_name, m.surname)), ''),
        a.holder_name
    ) as holder_name,
    a.assigned_on,
    a.returned_on,
    a.notes,
    null::numeric as deposit_amount,
    null::text as condition
from public.locker_assignments a
left join public.members m on m.id = a.member_id
where public.register_access_level('lockers') is not null;

create or replace view public.app_key_register as
select
    k.id as item_id,
    k.key_number as item_number,
    k.key_type as item_group,
    k.description as item_notes,
    k.is_active,
    a.id as assignment_id,
    m.wasra_number,
    coalesce(
        nullif(btrim(concat_ws(' ', m.first_name, m.surname)), ''),
        a.holder_name
    ) as holder_name,
    a.assigned_on,
    a.notes as assignment_notes,
    a.deposit_amount,
    a.condition
from public.register_keys k
left join public.key_assignments a
    on a.key_id = k.id and a.returned_on is null
left join public.members m on m.id = a.member_id
where public.register_access_level('keys') is not null;

create or replace view public.app_key_history as
select
    a.key_id as item_id,
    a.id as assignment_id,
    m.wasra_number,
    coalesce(
        nullif(btrim(concat_ws(' ', m.first_name, m.surname)), ''),
        a.holder_name
    ) as holder_name,
    a.assigned_on,
    a.returned_on,
    a.notes,
    a.deposit_amount,
    a.condition
from public.key_assignments a
left join public.members m on m.id = a.member_id
where public.register_access_level('keys') is not null;

-- ---------------------------------------------------------------------------
-- Assign / return functions
-- ---------------------------------------------------------------------------
create or replace function public.assign_locker(
    p_locker_id bigint,
    p_wasra_number integer default null,
    p_holder_name text default null,
    p_assigned_on date default null,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_member_id bigint;
    v_name text := nullif(btrim(coalesce(p_holder_name, '')), '');
begin
    if public.register_access_level('lockers') is distinct from 'edit' then
        return jsonb_build_object('outcome', 'not_authorised', 'message', 'You do not have edit access to the locker register.');
    end if;

    if not exists (select 1 from public.lockers where id = p_locker_id and is_active) then
        return jsonb_build_object('outcome', 'not_found', 'message', 'Locker not found or not active.');
    end if;

    if exists (select 1 from public.locker_assignments where locker_id = p_locker_id and returned_on is null) then
        return jsonb_build_object('outcome', 'already_assigned', 'message', 'This locker is already assigned. Return it first.');
    end if;

    if p_wasra_number is not null then
        select id into v_member_id
        from public.members
        where wasra_number = p_wasra_number and is_active = true
        limit 1;

        if v_member_id is null then
            return jsonb_build_object('outcome', 'member_not_found', 'message', 'No active member has that WASRA number.');
        end if;
    elsif v_name is null then
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'Enter a WASRA number or a holder name.');
    end if;

    insert into public.locker_assignments (locker_id, member_id, holder_name, assigned_on, notes)
    values (p_locker_id, v_member_id, v_name, coalesce(p_assigned_on, current_date), nullif(btrim(coalesce(p_notes, '')), ''));

    return jsonb_build_object('outcome', 'assigned', 'message', 'Locker assigned.');
end;
$$;

create or replace function public.return_locker(
    p_locker_id bigint,
    p_returned_on date default null,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_id bigint;
    v_assigned_on date;
    v_returned_on date := coalesce(p_returned_on, current_date);
begin
    if public.register_access_level('lockers') is distinct from 'edit' then
        return jsonb_build_object('outcome', 'not_authorised', 'message', 'You do not have edit access to the locker register.');
    end if;

    select id, assigned_on into v_id, v_assigned_on
    from public.locker_assignments
    where locker_id = p_locker_id and returned_on is null;

    if v_id is null then
        return jsonb_build_object('outcome', 'not_assigned', 'message', 'This locker is not currently assigned.');
    end if;

    if v_returned_on < v_assigned_on then
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'Return date cannot be before the assigned date.');
    end if;

    update public.locker_assignments
    set returned_on = v_returned_on,
        returned_by = auth.uid(),
        notes = case
            when nullif(btrim(coalesce(p_notes, '')), '') is null then notes
            else concat_ws(E'\n', notes, 'Return: ' || btrim(p_notes))
        end
    where id = v_id;

    return jsonb_build_object('outcome', 'returned', 'message', 'Locker returned.');
end;
$$;

create or replace function public.assign_key(
    p_key_id bigint,
    p_wasra_number integer default null,
    p_holder_name text default null,
    p_assigned_on date default null,
    p_deposit_amount numeric default null,
    p_condition text default null,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_member_id bigint;
    v_name text := nullif(btrim(coalesce(p_holder_name, '')), '');
begin
    if public.register_access_level('keys') is distinct from 'edit' then
        return jsonb_build_object('outcome', 'not_authorised', 'message', 'You do not have edit access to the key register.');
    end if;

    if not exists (select 1 from public.register_keys where id = p_key_id and is_active) then
        return jsonb_build_object('outcome', 'not_found', 'message', 'Key not found or not active.');
    end if;

    if exists (select 1 from public.key_assignments where key_id = p_key_id and returned_on is null) then
        return jsonb_build_object('outcome', 'already_assigned', 'message', 'This key is already issued. Return it first.');
    end if;

    if p_deposit_amount is not null and p_deposit_amount < 0 then
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'Deposit cannot be negative.');
    end if;

    if p_wasra_number is not null then
        select id into v_member_id
        from public.members
        where wasra_number = p_wasra_number and is_active = true
        limit 1;

        if v_member_id is null then
            return jsonb_build_object('outcome', 'member_not_found', 'message', 'No active member has that WASRA number.');
        end if;
    elsif v_name is null then
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'Enter a WASRA number or a holder name.');
    end if;

    insert into public.key_assignments (key_id, member_id, holder_name, assigned_on, deposit_amount, condition, notes)
    values (
        p_key_id, v_member_id, v_name, coalesce(p_assigned_on, current_date), p_deposit_amount,
        nullif(btrim(coalesce(p_condition, '')), ''), nullif(btrim(coalesce(p_notes, '')), '')
    );

    return jsonb_build_object('outcome', 'assigned', 'message', 'Key issued.');
end;
$$;

create or replace function public.return_key(
    p_key_id bigint,
    p_returned_on date default null,
    p_condition text default null,
    p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_id bigint;
    v_assigned_on date;
    v_returned_on date := coalesce(p_returned_on, current_date);
begin
    if public.register_access_level('keys') is distinct from 'edit' then
        return jsonb_build_object('outcome', 'not_authorised', 'message', 'You do not have edit access to the key register.');
    end if;

    select id, assigned_on into v_id, v_assigned_on
    from public.key_assignments
    where key_id = p_key_id and returned_on is null;

    if v_id is null then
        return jsonb_build_object('outcome', 'not_assigned', 'message', 'This key is not currently issued.');
    end if;

    if v_returned_on < v_assigned_on then
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'Return date cannot be before the issue date.');
    end if;

    update public.key_assignments
    set returned_on = v_returned_on,
        returned_by = auth.uid(),
        condition = coalesce(nullif(btrim(coalesce(p_condition, '')), ''), condition),
        notes = case
            when nullif(btrim(coalesce(p_notes, '')), '') is null then notes
            else concat_ws(E'\n', notes, 'Return: ' || btrim(p_notes))
        end
    where id = v_id;

    return jsonb_build_object('outcome', 'returned', 'message', 'Key returned.');
end;
$$;

-- ---------------------------------------------------------------------------
-- Venue issues (broken light, leaking tap, ...) with optional photo.
-- 'view' can read, 'edit' can report issues and update their status.
-- ---------------------------------------------------------------------------
create table if not exists public.venue_issues (
    id bigint generated by default as identity primary key,
    title text not null check (btrim(title) <> ''),
    description text,
    category text,
    location text,
    priority text not null default 'normal' check (priority in ('low', 'normal', 'urgent')),
    status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
    photo_path text,
    reported_by uuid not null default auth.uid(),
    created_at timestamptz not null default now(),
    resolved_at timestamptz,
    resolved_by uuid,
    resolution_notes text
);

alter table public.venue_issues enable row level security;

drop policy if exists venue_issues_select on public.venue_issues;
create policy venue_issues_select on public.venue_issues
    for select using (public.register_access_level('issues') is not null);

drop policy if exists venue_issues_insert on public.venue_issues;
create policy venue_issues_insert on public.venue_issues
    for insert with check (public.register_access_level('issues') = 'edit' and reported_by = auth.uid());

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
where public.register_access_level('issues') is not null;

-- Private storage bucket for issue photos
insert into storage.buckets (id, name, public)
values ('venue-issue-photos', 'venue-issue-photos', false)
on conflict (id) do nothing;

drop policy if exists venue_issue_photos_select on storage.objects;
create policy venue_issue_photos_select on storage.objects
    for select to authenticated
    using (bucket_id = 'venue-issue-photos' and public.register_access_level('issues') is not null);

drop policy if exists venue_issue_photos_insert on storage.objects;
create policy venue_issue_photos_insert on storage.objects
    for insert to authenticated
    with check (bucket_id = 'venue-issue-photos' and public.register_access_level('issues') = 'edit');

-- ---------------------------------------------------------------------------
-- Admin: manage who can see/edit each register
-- ---------------------------------------------------------------------------
create or replace function public.list_register_people()
returns table (
    user_id uuid,
    email text,
    full_name text,
    club text,
    job_position text,
    role text,
    lockers_access text,
    keys_access text,
    issues_access text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if public.current_staff_role() is distinct from 'admin' then
        return;
    end if;

    return query
    select
        u.id,
        u.email::text,
        rp.full_name,
        rp.club,
        rp.job_position,
        up.role::text,
        (select ra.access_level from public.register_access ra where ra.user_id = u.id and ra.register = 'lockers'),
        (select ra.access_level from public.register_access ra where ra.user_id = u.id and ra.register = 'keys'),
        (select ra.access_level from public.register_access ra where ra.user_id = u.id and ra.register = 'issues')
    from auth.users u
    left join public.user_profiles up on up.user_id = u.id
    left join public.register_people rp on rp.user_id = u.id
    where up.user_id is not null
       or rp.user_id is not null
       or exists (select 1 from public.register_access ra where ra.user_id = u.id)
    order by rp.club nulls last, rp.full_name nulls last, u.email;
end;
$$;

-- Give someone access by email. The person must already have a login
-- (create the user in Supabase Authentication first if they do not).
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

    if p_lockers not in ('none', 'view', 'edit') or p_keys not in ('none', 'view', 'edit') or p_issues not in ('none', 'view', 'edit') then
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'Access must be none, view or edit.');
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

-- Admin can also update the label (name, club, job_position) of an existing person.
create or replace function public.set_register_person(
    p_user_id uuid,
    p_full_name text,
    p_club text,
    p_position text
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

    insert into public.register_people (user_id, full_name, club, job_position)
    values (p_user_id, nullif(btrim(coalesce(p_full_name, '')), ''), nullif(btrim(coalesce(p_club, '')), ''), nullif(btrim(coalesce(p_position, '')), ''))
    on conflict (user_id) do update
        set full_name = excluded.full_name, club = excluded.club, job_position = excluded.job_position, updated_at = now();

    return jsonb_build_object('outcome', 'saved', 'message', 'Details saved.');
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
    elsif p_access_level in ('view', 'edit') then
        insert into public.register_access (user_id, register, access_level)
        values (p_user_id, p_register, p_access_level)
        on conflict (user_id, register)
        do update set access_level = excluded.access_level, updated_at = now();
    else
        return jsonb_build_object('outcome', 'invalid_request', 'message', 'Access must be none, view or edit.');
    end if;

    return jsonb_build_object('outcome', 'saved', 'message', 'Access updated.');
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on public.register_access, public.lockers, public.locker_assignments,
    public.register_keys, public.key_assignments from anon;
revoke all on public.app_locker_register, public.app_locker_history,
    public.app_key_register, public.app_key_history from anon;

grant select, insert, update, delete on public.register_access, public.register_people to authenticated;
revoke all on public.register_people from anon;
revoke all on public.venue_issues, public.app_venue_issues from anon;
grant select, insert, update on public.venue_issues to authenticated;
grant select on public.app_venue_issues to authenticated;
grant select, insert, update on public.lockers, public.register_keys to authenticated;
grant select on public.locker_assignments, public.key_assignments to authenticated;
grant select on public.app_locker_register, public.app_locker_history,
    public.app_key_register, public.app_key_history to authenticated;

revoke all on function public.register_access_level(text) from public, anon;
revoke all on function public.is_register_admin() from public, anon;
revoke all on function public.assign_locker(bigint, integer, text, date, text) from public, anon;
revoke all on function public.return_locker(bigint, date, text) from public, anon;
revoke all on function public.assign_key(bigint, integer, text, date, numeric, text, text) from public, anon;
revoke all on function public.return_key(bigint, date, text, text) from public, anon;
revoke all on function public.list_register_people() from public, anon;
revoke all on function public.grant_register_access_by_email(text, text, text, text, text, text, text) from public, anon;
revoke all on function public.set_register_person(uuid, text, text, text) from public, anon;
revoke all on function public.set_register_access(uuid, text, text) from public, anon;

grant execute on function public.register_access_level(text) to authenticated;
grant execute on function public.is_register_admin() to authenticated;
grant execute on function public.assign_locker(bigint, integer, text, date, text) to authenticated;
grant execute on function public.return_locker(bigint, date, text) to authenticated;
grant execute on function public.assign_key(bigint, integer, text, date, numeric, text, text) to authenticated;
grant execute on function public.return_key(bigint, date, text, text) to authenticated;
grant execute on function public.list_register_people() to authenticated;
grant execute on function public.grant_register_access_by_email(text, text, text, text, text, text, text) to authenticated;
grant execute on function public.set_register_person(uuid, text, text, text) to authenticated;
grant execute on function public.set_register_access(uuid, text, text) to authenticated;

commit;
