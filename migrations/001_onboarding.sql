-- =========================================================
-- PopChats — Onboarding migration
-- Run once in: Supabase → SQL Editor → New query
-- =========================================================

-- 1. Add new profile columns
alter table public.profiles
  add column if not exists full_name      text,
  add column if not exists dob            date,
  add column if not exists gender         text check (gender in ('male','female','other','prefer_not')),
  add column if not exists onboarded      boolean default false;

-- 2. Public-readable avatars storage bucket (skip if it already exists)
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- 3. RLS for avatars bucket
-- Anyone authed can read; users can only upload/update/delete files in their own folder (named by their UID).
drop policy if exists "avatars_read_all"   on storage.objects;
drop policy if exists "avatars_insert_own" on storage.objects;
drop policy if exists "avatars_update_own" on storage.objects;
drop policy if exists "avatars_delete_own" on storage.objects;

create policy "avatars_read_all" on storage.objects
  for select to public
  using (bucket_id = 'avatars');

create policy "avatars_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
