-- 009_signaling.sql — WebRTC signaling table
-- Stores offer/answer/ICE candidate exchange between peers via Supabase Realtime

create table if not exists public.signaling (
  id          uuid primary key default gen_random_uuid(),
  room_id     text not null,
  sender_id   text not null,
  type        text not null check (type in ('offer','answer','ice-candidate','bye')),
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists signaling_room_id_idx on public.signaling (room_id, created_at);
create index if not exists signaling_created_at_idx on public.signaling (created_at);

-- Enable Realtime on this table
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'signaling'
  ) then
    execute 'alter publication supabase_realtime add table public.signaling';
  end if;
end $$;

-- RLS: any authenticated user can insert/read/delete signaling rows
-- (room_id provides the access boundary; signaling rows are short-lived)
alter table public.signaling enable row level security;

drop policy if exists "signaling_select_all" on public.signaling;
create policy "signaling_select_all" on public.signaling
  for select using (true);

drop policy if exists "signaling_insert_all" on public.signaling;
create policy "signaling_insert_all" on public.signaling
  for insert with check (true);

drop policy if exists "signaling_delete_all" on public.signaling;
create policy "signaling_delete_all" on public.signaling
  for delete using (true);

-- Auto-cleanup: signaling rows older than 1 hour are stale
-- (run this in a cron, or call manually)
create or replace function public.cleanup_stale_signaling()
returns void language sql as $$
  delete from public.signaling where created_at < now() - interval '1 hour';
$$;
