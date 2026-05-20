-- =========================================================
-- PopChats — add bio column
-- Run once in: Supabase → SQL Editor → New query
-- =========================================================

alter table public.profiles
  add column if not exists bio text;
