-- =========================================================
-- PopChats — 18+ age gate (server-enforced)
-- Run once in: Supabase → SQL Editor → New query
-- Idempotent: safe to re-run.
--
-- The client checkbox is NOT trustworthy: anyone can call the Supabase
-- API directly with the publishable key. Age is validated HERE, server-side.
-- =========================================================

alter table public.profiles
  add column if not exists dob             date,
  add column if not exists is_adult        boolean not null default false,
  add column if not exists gender          text,
  add column if not exists agreed_terms_at timestamptz;

-- Set date of birth once, with server-side 18+ enforcement.
-- Call this from onboarding ("Complete profile") instead of writing dob directly.
create or replace function public.set_date_of_birth(_dob date, _gender text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  if _dob is null then raise exception 'dob required'; end if;
  if _dob > (current_date - interval '18 years') then
    raise exception 'must_be_18';
  end if;
  if _dob < (current_date - interval '120 years') then
    raise exception 'invalid_dob';
  end if;
  update public.profiles
     set dob = _dob,
         is_adult = true,
         gender = coalesce(_gender, gender),
         agreed_terms_at = coalesce(agreed_terms_at, now())
   where id = me;
end;
$$;
grant execute on function public.set_date_of_birth(date, text) to authenticated;

-- Record T&C / 18+ consent (call when the user ticks the box).
create or replace function public.accept_terms()
returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  update public.profiles set agreed_terms_at = now() where id = me;
end;
$$;
grant execute on function public.accept_terms() to authenticated;

-- Helper to add to matching / messaging RPCs to hard-block minors:
--   if not public.is_adult() then raise exception 'must_be_18'; end if;
create or replace function public.is_adult()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_adult from public.profiles where id = auth.uid()), false);
$$;
grant execute on function public.is_adult() to authenticated;

-- Keep dob/gender private: they must NOT be exposed by "profiles_select_all",
-- which currently returns every column to every authenticated user.
-- Read other users through this safe view instead.
create or replace view public.public_profiles as
  select id, username, display_name, full_name, avatar_url, theme, online, last_seen, bio, is_adult
  from public.profiles;
grant select on public.public_profiles to authenticated;

-- NOTE (manual, do after switching the app to read public_profiles for other
-- users): tighten the base table so users only read their OWN full row:
--   drop policy "profiles_select_all" on public.profiles;
--   create policy "profiles_select_own" on public.profiles
--     for select to authenticated using (id = auth.uid());
-- Left commented so it doesn't break screens still reading profiles directly.
