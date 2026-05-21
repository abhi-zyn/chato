-- =========================================================
-- PopChats — follows table + helper RPCs
-- Run once in: Supabase → SQL Editor → New query
-- =========================================================

create table if not exists public.follows (
  follower_id  uuid references public.profiles(id) on delete cascade,
  following_id uuid references public.profiles(id) on delete cascade,
  created_at   timestamptz default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

create index if not exists idx_follows_follower  on public.follows(follower_id);
create index if not exists idx_follows_following on public.follows(following_id);

alter table public.follows enable row level security;

drop policy if exists "follows_select_all" on public.follows;
create policy "follows_select_all" on public.follows
  for select to authenticated using (true);

drop policy if exists "follows_insert_own" on public.follows;
create policy "follows_insert_own" on public.follows
  for insert to authenticated with check (follower_id = auth.uid());

drop policy if exists "follows_delete_own" on public.follows;
create policy "follows_delete_own" on public.follows
  for delete to authenticated using (follower_id = auth.uid());

-- Helper RPC: get follower/following counts for a user in one round-trip
create or replace function public.get_follow_counts(uid uuid)
returns table (followers bigint, following bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from follows where following_id = uid) as followers,
    (select count(*) from follows where follower_id = uid)  as following;
$$;

grant execute on function public.get_follow_counts(uuid) to authenticated;
