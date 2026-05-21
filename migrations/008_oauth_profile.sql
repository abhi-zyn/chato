-- =========================================================
-- PopChats — Hydrate profile from OAuth metadata (Google etc.)
-- Run once in: Supabase → SQL Editor → New query
-- Idempotent: safe to re-run.
-- =========================================================

-- Add columns if missing (already added in 001_onboarding but defensive)
alter table public.profiles
  add column if not exists full_name  text,
  add column if not exists avatar_url text;

-- Updated trigger: pulls full_name + avatar_url from OAuth metadata
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uname text;
  fname text;
  av    text;
begin
  -- Username: prefer explicit metadata, else email local-part
  uname := coalesce(
    new.raw_user_meta_data->>'username',
    split_part(coalesce(new.email,''), '@', 1)
  );
  -- Strip non-alphanumerics from oauth-derived usernames
  uname := regexp_replace(coalesce(uname, ''), '[^a-zA-Z0-9_]', '_', 'g');
  if uname = '' then uname := 'user'; end if;
  -- Ensure uniqueness
  if exists (select 1 from public.profiles where username = uname) then
    uname := uname || '_' || substr(new.id::text, 1, 6);
  end if;

  -- Full name: try every common OAuth field
  fname := coalesce(
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'display_name',
    uname
  );

  -- Avatar: Google uses 'picture', most others use 'avatar_url'
  av := coalesce(
    new.raw_user_meta_data->>'avatar_url',
    new.raw_user_meta_data->>'picture'
  );

  insert into public.profiles (id, username, display_name, full_name, avatar_url)
  values (new.id, uname, fname, fname, av);
  return new;
end;
$$;

-- Backfill existing users whose profile is missing data
update public.profiles p
set
  full_name  = coalesce(p.full_name,  u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
  avatar_url = coalesce(p.avatar_url, u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
from auth.users u
where p.id = u.id
  and (p.full_name is null or p.avatar_url is null);
