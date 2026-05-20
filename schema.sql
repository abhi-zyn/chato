-- =========================================================
-- PopChats — Supabase schema
-- Run this entire file once in:  Supabase → SQL Editor → New query
-- =========================================================

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------
-- profiles
-- ---------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text unique not null,
  display_name  text,
  avatar_url    text,
  theme         text default 'lavender',
  online        boolean default false,
  last_seen     timestamptz default now(),
  created_at    timestamptz default now()
);

-- Auto-create a profile row whenever a new auth.user is created
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uname text;
begin
  uname := coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1));
  -- Ensure uniqueness
  if exists (select 1 from public.profiles where username = uname) then
    uname := uname || '_' || substr(new.id::text, 1, 6);
  end if;
  insert into public.profiles (id, username, display_name)
  values (new.id, uname, coalesce(new.raw_user_meta_data->>'display_name', uname));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------
-- chats / chat_members / messages
-- ---------------------------------------------------------
create table if not exists public.chats (
  id          uuid primary key default uuid_generate_v4(),
  is_stranger boolean default false,
  created_at  timestamptz default now()
);

create table if not exists public.chat_members (
  chat_id   uuid references public.chats(id) on delete cascade,
  user_id   uuid references public.profiles(id) on delete cascade,
  joined_at timestamptz default now(),
  primary key (chat_id, user_id)
);
create index if not exists idx_chat_members_user on public.chat_members(user_id);

create table if not exists public.messages (
  id         uuid primary key default uuid_generate_v4(),
  chat_id    uuid references public.chats(id) on delete cascade,
  sender_id  uuid references public.profiles(id) on delete cascade,
  text       text not null,
  created_at timestamptz default now()
);
create index if not exists idx_messages_chat_created on public.messages(chat_id, created_at);

-- ---------------------------------------------------------
-- notifications / calls (history only)
-- ---------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid references public.profiles(id) on delete cascade,
  kind       text,
  payload    jsonb default '{}'::jsonb,
  read       boolean default false,
  created_at timestamptz default now()
);
create index if not exists idx_notifications_user on public.notifications(user_id, created_at desc);

create table if not exists public.calls (
  id               uuid primary key default uuid_generate_v4(),
  caller_id        uuid references public.profiles(id) on delete cascade,
  callee_id        uuid references public.profiles(id) on delete cascade,
  kind             text check (kind in ('incoming','outgoing','missed')),
  duration_seconds int default 0,
  created_at       timestamptz default now()
);
create index if not exists idx_calls_caller on public.calls(caller_id, created_at desc);
create index if not exists idx_calls_callee on public.calls(callee_id, created_at desc);

-- ---------------------------------------------------------
-- Helper: is the current user a member of this chat?
-- SECURITY DEFINER avoids recursive RLS on chat_members.
-- ---------------------------------------------------------
create or replace function public.is_chat_member(_chat_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_members
    where chat_id = _chat_id and user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------
-- RLS
-- ---------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.chats          enable row level security;
alter table public.chat_members   enable row level security;
alter table public.messages       enable row level security;
alter table public.notifications  enable row level security;
alter table public.calls          enable row level security;

-- profiles: any authed user can read; user can update/insert own
drop policy if exists "profiles_select_all"   on public.profiles;
drop policy if exists "profiles_update_own"   on public.profiles;
drop policy if exists "profiles_insert_own"   on public.profiles;
create policy "profiles_select_all" on public.profiles
  for select to authenticated using (true);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- chats / chat_members / messages: only members
drop policy if exists "chats_select_member"        on public.chats;
drop policy if exists "chat_members_select_member" on public.chat_members;
drop policy if exists "chat_members_insert_self"   on public.chat_members;
drop policy if exists "messages_select_member"     on public.messages;
drop policy if exists "messages_insert_self"       on public.messages;

create policy "chats_select_member" on public.chats
  for select to authenticated using (public.is_chat_member(id));

create policy "chat_members_select_member" on public.chat_members
  for select to authenticated using (public.is_chat_member(chat_id));

-- Direct inserts only allowed for self; chat creation goes through SECURITY DEFINER RPCs below.
create policy "chat_members_insert_self" on public.chat_members
  for insert to authenticated with check (user_id = auth.uid());

create policy "messages_select_member" on public.messages
  for select to authenticated using (public.is_chat_member(chat_id));

create policy "messages_insert_self" on public.messages
  for insert to authenticated
  with check (sender_id = auth.uid() and public.is_chat_member(chat_id));

-- notifications & calls: own only
drop policy if exists "notif_own" on public.notifications;
create policy "notif_own" on public.notifications
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "calls_own" on public.calls;
create policy "calls_own" on public.calls
  for all to authenticated
  using (caller_id = auth.uid() or callee_id = auth.uid())
  with check (caller_id = auth.uid() or callee_id = auth.uid());

-- ---------------------------------------------------------
-- RPCs for atomic chat creation (bypasses RLS via SECURITY DEFINER)
-- ---------------------------------------------------------

-- 1-on-1 chat: returns existing chat between me and other, or creates a new one
create or replace function public.get_or_create_dm(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me            uuid := auth.uid();
  existing_chat uuid;
  new_chat_id   uuid;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;
  if other_user_id = me then
    raise exception 'cannot DM yourself';
  end if;

  -- Look for an existing non-stranger chat that contains exactly the two of us
  select c.id into existing_chat
  from public.chats c
  where c.is_stranger = false
    and (select count(*) from public.chat_members cm where cm.chat_id = c.id) = 2
    and exists (select 1 from public.chat_members where chat_id = c.id and user_id = me)
    and exists (select 1 from public.chat_members where chat_id = c.id and user_id = other_user_id)
  limit 1;

  if existing_chat is not null then
    return existing_chat;
  end if;

  insert into public.chats(is_stranger) values (false) returning id into new_chat_id;
  insert into public.chat_members(chat_id, user_id) values (new_chat_id, me);
  insert into public.chat_members(chat_id, user_id) values (new_chat_id, other_user_id);
  return new_chat_id;
end;
$$;

grant execute on function public.get_or_create_dm(uuid) to authenticated;

-- Stranger chat: always creates a new chat marked is_stranger=true
create or replace function public.start_stranger_chat(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me          uuid := auth.uid();
  new_chat_id uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if other_user_id = me then raise exception 'cannot match yourself'; end if;

  insert into public.chats(is_stranger) values (true) returning id into new_chat_id;
  insert into public.chat_members(chat_id, user_id) values (new_chat_id, me);
  insert into public.chat_members(chat_id, user_id) values (new_chat_id, other_user_id);
  return new_chat_id;
end;
$$;

grant execute on function public.start_stranger_chat(uuid) to authenticated;

-- Pick a random profile that isn't me. Prefers online users; falls back to anyone.
create or replace function public.pick_random_stranger()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  picked uuid;
begin
  select id into picked from public.profiles
   where id <> auth.uid() and online = true
   order by random() limit 1;
  if picked is null then
    select id into picked from public.profiles
     where id <> auth.uid()
     order by random() limit 1;
  end if;
  return picked;
end;
$$;

grant execute on function public.pick_random_stranger() to authenticated;

-- ---------------------------------------------------------
-- Realtime: emit changes for messages and notifications
-- ---------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    execute 'alter publication supabase_realtime add table public.messages';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
end $$;
