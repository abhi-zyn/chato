-- =========================================================
-- PopChats — User & message reporting (Trust & Safety)
-- Run once in: Supabase → SQL Editor → New query
-- Idempotent: safe to re-run.
-- =========================================================

create table if not exists public.reports (
  id           uuid primary key default uuid_generate_v4(),
  reporter_id  uuid references public.profiles(id) on delete set null,
  reported_id  uuid references public.profiles(id) on delete cascade,
  chat_id      uuid references public.chats(id)    on delete set null,
  message_id   uuid,
  reason       text not null,
  details      text,
  status       text not null default 'open',   -- open | reviewing | actioned | dismissed
  created_at   timestamptz default now()
);
create index if not exists idx_reports_reported on public.reports(reported_id, created_at desc);
create index if not exists idx_reports_status   on public.reports(status, created_at desc);

alter table public.reports enable row level security;

-- Reporters may create their own reports. No SELECT policy => only the
-- service_role (moderation dashboard / edge functions) can read the queue.
drop policy if exists "reports_insert_self" on public.reports;
create policy "reports_insert_self" on public.reports
  for insert to authenticated
  with check (reporter_id = auth.uid());

-- Convenience RPC so the client never sets reporter_id itself.
create or replace function public.report_user(
  _reported uuid, _reason text, _details text default null,
  _chat_id uuid default null, _message_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); new_id uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if _reported is null or _reported = me then raise exception 'invalid target'; end if;
  if _reason is null or length(btrim(_reason)) = 0 then raise exception 'reason required'; end if;
  insert into public.reports(reporter_id, reported_id, reason, details, chat_id, message_id)
  values (me, _reported, _reason, _details, _chat_id, _message_id)
  returning id into new_id;
  return new_id;
end;
$$;
grant execute on function public.report_user(uuid, text, text, uuid, uuid) to authenticated;
