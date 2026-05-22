-- =========================================================
-- PopChats — Push subscriptions (Web Push / VAPID)
-- Run once in: Supabase → SQL Editor → New query
-- Idempotent: safe to re-run.
-- =========================================================

create table if not exists public.push_subscriptions (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz default now(),
  last_used_at  timestamptz default now()
);

create index if not exists idx_push_subs_user
  on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

-- A user can only see / modify their own subscriptions.
drop policy if exists "push_subs_own"        on public.push_subscriptions;
drop policy if exists "push_subs_insert_own" on public.push_subscriptions;

create policy "push_subs_own"
  on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- The Edge Function (running with the service role key) must read
-- subscriptions for any user whose chat received a new message.
-- Service role bypasses RLS, so no extra policy is needed for it.

-- Helper RPC: list other chat members (used by the Edge Function via the
-- service role to figure out who needs a push). Kept here for transparency,
-- though the Edge Function can also use a plain query with the service key.
create or replace function public.chat_other_members(_chat_id uuid, _exclude uuid)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select user_id from public.chat_members
   where chat_id = _chat_id and user_id <> _exclude;
$$;

grant execute on function public.chat_other_members(uuid, uuid) to authenticated, service_role;
