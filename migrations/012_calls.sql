-- Call logs
create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references auth.users(id) on delete cascade,
  callee_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'voice', -- voice, video, missed, unanswered
  created_at timestamptz not null default now()
);

alter table public.calls enable row level security;

create policy "Users can view their own calls"
  on public.calls for select
  using (auth.uid() = caller_id or auth.uid() = callee_id);

create policy "Users can insert their own calls"
  on public.calls for insert
  with check (auth.uid() = caller_id or auth.uid() = callee_id);

create index if not exists idx_calls_caller on public.calls(caller_id, created_at desc);
create index if not exists idx_calls_callee on public.calls(callee_id, created_at desc);
