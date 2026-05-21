-- =========================================================
-- PopChats — Friendships (replaces follows)
-- Run once in: Supabase → SQL Editor → New query
-- Idempotent: safe to re-run.
-- =========================================================

-- ---------- friendship_status enum ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'friendship_status') then
    create type friendship_status as enum ('pending','accepted','declined','blocked');
  end if;
end $$;

-- ---------- friendships table (canonical pair) ----------
create table if not exists public.friendships (
  user_low     uuid not null references public.profiles(id) on delete cascade,
  user_high    uuid not null references public.profiles(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  status       friendship_status not null default 'pending',
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  primary key (user_low, user_high),
  check (user_low < user_high)
);

create index if not exists idx_friendships_low    on public.friendships(user_low);
create index if not exists idx_friendships_high   on public.friendships(user_high);
create index if not exists idx_friendships_status on public.friendships(status);

alter table public.friendships enable row level security;

drop policy if exists "fr_select_own" on public.friendships;
create policy "fr_select_own" on public.friendships
  for select to authenticated
  using (auth.uid() in (user_low, user_high));

-- All writes go through SECURITY DEFINER RPCs below — no direct insert/update/delete policy.

-- ---------- helpers ----------
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted'
      and user_low  = least(a, b)
      and user_high = greatest(a, b)
  );
$$;

grant execute on function public.are_friends(uuid, uuid) to authenticated;

-- ---------- backfill from old follows table (if it exists) ----------
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'public' and table_name = 'follows') then
    -- Mutual follows → accepted friendships
    insert into public.friendships (user_low, user_high, requested_by, status)
    select least(a.follower_id, a.following_id),
           greatest(a.follower_id, a.following_id),
           a.follower_id,
           'accepted'
    from public.follows a
    join public.follows b
      on b.follower_id  = a.following_id
     and b.following_id = a.follower_id
    where a.follower_id < a.following_id
    on conflict (user_low, user_high) do update
       set status = 'accepted', updated_at = now();

    -- One-sided follows → pending (requested_by = follower)
    insert into public.friendships (user_low, user_high, requested_by, status)
    select least(f.follower_id, f.following_id),
           greatest(f.follower_id, f.following_id),
           f.follower_id,
           'pending'
    from public.follows f
    where not exists (
      select 1 from public.follows g
      where g.follower_id  = f.following_id
        and g.following_id = f.follower_id
    )
    on conflict (user_low, user_high) do nothing;

    -- Drop legacy table + helper
    drop function if exists public.get_follow_counts(uuid);
    drop table public.follows cascade;
  end if;
end $$;

-- ---------- RPCs ----------

-- Returns one of: 'self' | 'none' | 'outgoing' | 'incoming' | 'friends' | 'declined' | 'blocked'
create or replace function public.friendship_state(other uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  r  public.friendships%rowtype;
begin
  if me is null then return 'none'; end if;
  if other = me then return 'self'; end if;
  select * into r from public.friendships
   where user_low = least(me, other) and user_high = greatest(me, other);
  if not found then return 'none'; end if;
  if r.status = 'accepted' then return 'friends'; end if;
  if r.status = 'blocked'  then return 'blocked'; end if;
  if r.status = 'declined' then return 'declined'; end if;
  -- pending
  if r.requested_by = me then return 'outgoing'; else return 'incoming'; end if;
end;
$$;

grant execute on function public.friendship_state(uuid) to authenticated;

-- Bulk version: returns rows {other_id, state} for a list of user ids
create or replace function public.friendship_states_for(other_ids uuid[])
returns table (other_id uuid, state text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  oid uuid;
begin
  if me is null then return; end if;
  foreach oid in array other_ids loop
    other_id := oid;
    state := public.friendship_state(oid);
    return next;
  end loop;
end;
$$;

grant execute on function public.friendship_states_for(uuid[]) to authenticated;

-- Send (or auto-accept if other side already requested)
create or replace function public.send_friend_request(other uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  lo uuid; hi uuid;
  r  public.friendships%rowtype;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if other = me then raise exception 'cannot friend yourself'; end if;
  lo := least(me, other); hi := greatest(me, other);

  select * into r from public.friendships where user_low = lo and user_high = hi;

  if not found then
    insert into public.friendships (user_low, user_high, requested_by, status)
    values (lo, hi, me, 'pending');
    insert into public.notifications (user_id, kind, payload)
    values (other, 'friend_request', jsonb_build_object('from', me));
    return 'pending';
  end if;

  if r.status = 'accepted' then return 'friends'; end if;
  if r.status = 'blocked'  then raise exception 'cannot send request'; end if;

  -- pending or declined
  if r.requested_by = me then
    -- Already outgoing → no-op
    return 'pending';
  else
    -- Incoming pending and we're sending → mutual interest, auto-accept
    update public.friendships
       set status = 'accepted', updated_at = now()
     where user_low = lo and user_high = hi;
    -- Provision DM
    perform public._ensure_dm(me, other);
    insert into public.notifications (user_id, kind, payload)
    values (r.requested_by, 'friend_accepted', jsonb_build_object('from', me));
    return 'friends';
  end if;
end;
$$;

grant execute on function public.send_friend_request(uuid) to authenticated;

-- Internal helper: create a DM if none exists between two users (bypasses friend gate)
create or replace function public._ensure_dm(a uuid, b uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing uuid;
  new_id   uuid;
begin
  select c.id into existing
    from public.chats c
   where c.is_stranger = false
     and (select count(*) from public.chat_members cm where cm.chat_id = c.id) = 2
     and exists (select 1 from public.chat_members cm where cm.chat_id = c.id and cm.user_id = a)
     and exists (select 1 from public.chat_members cm where cm.chat_id = c.id and cm.user_id = b)
   limit 1;
  if existing is not null then return existing; end if;

  insert into public.chats(is_stranger) values (false) returning id into new_id;
  insert into public.chat_members(chat_id, user_id) values (new_id, a);
  insert into public.chat_members(chat_id, user_id) values (new_id, b);
  return new_id;
end;
$$;

-- Accept incoming request → friends + DM provisioned
create or replace function public.accept_friend_request(other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  lo uuid; hi uuid;
  r  public.friendships%rowtype;
  v_chat_id uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if other = me then raise exception 'cannot accept self'; end if;
  lo := least(me, other); hi := greatest(me, other);
  select * into r from public.friendships where user_low = lo and user_high = hi;
  if not found then raise exception 'no request to accept'; end if;
  if r.status = 'accepted' then
    -- already friends — still return chat id
    return public._ensure_dm(me, other);
  end if;
  if r.status not in ('pending','declined') then
    raise exception 'cannot accept';
  end if;
  if r.requested_by = me then raise exception 'cannot accept your own request'; end if;

  update public.friendships
     set status = 'accepted', updated_at = now()
   where user_low = lo and user_high = hi;

  v_chat_id := public._ensure_dm(me, other);

  insert into public.notifications (user_id, kind, payload)
  values (r.requested_by, 'friend_accepted',
          jsonb_build_object('from', me, 'chat_id', v_chat_id));

  return v_chat_id;
end;
$$;

grant execute on function public.accept_friend_request(uuid) to authenticated;

-- Decline incoming request
create or replace function public.decline_friend_request(other uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  lo uuid; hi uuid;
  r  public.friendships%rowtype;
begin
  if me is null then raise exception 'not authenticated'; end if;
  lo := least(me, other); hi := greatest(me, other);
  select * into r from public.friendships where user_low = lo and user_high = hi;
  if not found or r.status <> 'pending' then return; end if;
  if r.requested_by = me then raise exception 'cannot decline your own request'; end if;
  update public.friendships
     set status = 'declined', updated_at = now()
   where user_low = lo and user_high = hi;
end;
$$;

grant execute on function public.decline_friend_request(uuid) to authenticated;

-- Cancel outgoing request
create or replace function public.cancel_friend_request(other uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  lo uuid; hi uuid;
  r  public.friendships%rowtype;
begin
  if me is null then raise exception 'not authenticated'; end if;
  lo := least(me, other); hi := greatest(me, other);
  select * into r from public.friendships where user_low = lo and user_high = hi;
  if not found or r.status <> 'pending' then return; end if;
  if r.requested_by <> me then raise exception 'not your request'; end if;
  delete from public.friendships where user_low = lo and user_high = hi;
end;
$$;

grant execute on function public.cancel_friend_request(uuid) to authenticated;

-- Unfriend (only when accepted)
create or replace function public.unfriend(other uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  lo uuid; hi uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  lo := least(me, other); hi := greatest(me, other);
  delete from public.friendships
   where user_low = lo and user_high = hi and status = 'accepted';
end;
$$;

grant execute on function public.unfriend(uuid) to authenticated;

-- List incoming + outgoing pending requests with profile info
create or replace function public.list_friend_requests()
returns table (
  other_id     uuid,
  username     text,
  display_name text,
  full_name    text,
  avatar_url   text,
  bio          text,
  direction    text,   -- 'incoming' | 'outgoing'
  created_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then return; end if;
  return query
  select p.id, p.username, p.display_name,
         coalesce(p.full_name, p.display_name) as full_name,
         p.avatar_url, p.bio,
         case when fr.requested_by = me then 'outgoing' else 'incoming' end,
         fr.created_at
  from public.friendships fr
  join public.profiles p
    on p.id = case when fr.user_low = me then fr.user_high else fr.user_low end
  where fr.status = 'pending'
    and me in (fr.user_low, fr.user_high)
  order by fr.created_at desc;
end;
$$;

grant execute on function public.list_friend_requests() to authenticated;

-- List my accepted friends
create or replace function public.list_friends()
returns table (
  other_id     uuid,
  username     text,
  display_name text,
  full_name    text,
  avatar_url   text,
  bio          text,
  online       boolean,
  since        timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then return; end if;
  return query
  select p.id, p.username, p.display_name,
         coalesce(p.full_name, p.display_name) as full_name,
         p.avatar_url, p.bio, p.online, fr.created_at
  from public.friendships fr
  join public.profiles p
    on p.id = case when fr.user_low = me then fr.user_high else fr.user_low end
  where fr.status = 'accepted'
    and me in (fr.user_low, fr.user_high)
  order by p.online desc, p.username;
end;
$$;

grant execute on function public.list_friends() to authenticated;

-- Friend-since timestamp for the profile sheet
create or replace function public.friend_since(other uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select fr.created_at
    from public.friendships fr
   where fr.status = 'accepted'
     and fr.user_low  = least(auth.uid(), other)
     and fr.user_high = greatest(auth.uid(), other)
   limit 1;
$$;

grant execute on function public.friend_since(uuid) to authenticated;

-- ---------- Tighten get_or_create_dm: only friends or existing DMs ----------
create or replace function public.get_or_create_dm(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me            uuid := auth.uid();
  existing_chat uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if other_user_id = me then raise exception 'cannot DM yourself'; end if;

  -- Existing DM? Return it (read-only access for non-friends; insert is gated by RLS).
  select c.id into existing_chat
    from public.chats c
   where c.is_stranger = false
     and (select count(*) from public.chat_members cm where cm.chat_id = c.id) = 2
     and exists (select 1 from public.chat_members cm where cm.chat_id = c.id and cm.user_id = me)
     and exists (select 1 from public.chat_members cm where cm.chat_id = c.id and cm.user_id = other_user_id)
   limit 1;
  if existing_chat is not null then return existing_chat; end if;

  -- New DM only allowed when friends
  if not public.are_friends(me, other_user_id) then
    raise exception 'not friends';
  end if;

  return public._ensure_dm(me, other_user_id);
end;
$$;

grant execute on function public.get_or_create_dm(uuid) to authenticated;

-- ---------- Tighten message insert: friends-only for DMs ----------
drop policy if exists "messages_insert_self" on public.messages;
create policy "messages_insert_self" on public.messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_chat_member(chat_id)
    and (
      exists (select 1 from public.chats c where c.id = chat_id and c.is_stranger = true)
      or exists (
        select 1
          from public.chat_members m1
          join public.chat_members m2
            on m1.chat_id = m2.chat_id
         where m1.chat_id = chat_id
           and m1.user_id = auth.uid()
           and m2.user_id <> auth.uid()
           and public.are_friends(m1.user_id, m2.user_id)
      )
    )
  );

-- ---------- Realtime: friendships ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friendships'
  ) then
    execute 'alter publication supabase_realtime add table public.friendships';
  end if;
end $$;
