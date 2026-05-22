-- =========================================================
-- PopChats — Per-member read receipts (Seen indicator)
-- Run once in: Supabase → SQL Editor → New query
-- Idempotent: safe to re-run.
-- =========================================================

-- 1) last_read_at on chat_members --------------------------------------------
alter table public.chat_members
  add column if not exists last_read_at timestamptz default now();

create index if not exists idx_chat_members_chat_user
  on public.chat_members(chat_id, user_id);

-- 2) RLS: allow a user to UPDATE their own membership row only
-- (existing select/insert policies remain in place)
drop policy if exists "chat_members_update_own" on public.chat_members;
create policy "chat_members_update_own" on public.chat_members
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 3) RPC: mark this chat as read by the current user (sets last_read_at = now())
create or replace function public.mark_chat_read(_chat_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  ts timestamptz := now();
begin
  if me is null then raise exception 'not authenticated'; end if;
  if not public.is_chat_member(_chat_id) then raise exception 'not a member'; end if;

  update public.chat_members
     set last_read_at = ts
   where chat_id = _chat_id and user_id = me;

  return ts;
end;
$$;

grant execute on function public.mark_chat_read(uuid) to authenticated;

-- 4) RPC: get all members' read state for a chat (used by client to render Seen)
create or replace function public.chat_read_states(_chat_id uuid)
returns table (user_id uuid, last_read_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not public.is_chat_member(_chat_id) then raise exception 'not a member'; end if;

  return query
  select cm.user_id, cm.last_read_at
    from public.chat_members cm
   where cm.chat_id = _chat_id;
end;
$$;

grant execute on function public.chat_read_states(uuid) to authenticated;

-- 5) Realtime: publish chat_members changes so the sender can see when the
--    other side reads the conversation (UPDATE on last_read_at).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_members'
  ) then
    execute 'alter publication supabase_realtime add table public.chat_members';
  end if;
end $$;
