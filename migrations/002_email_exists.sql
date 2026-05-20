-- =========================================================
-- PopChats — email_exists RPC
-- Run once in: Supabase → SQL Editor → New query
-- =========================================================
-- Lets the client check if an email is already registered.
-- Trade-off: enables user enumeration. Acceptable for a casual
-- consumer chat app where signup UX > enumeration protection.

create or replace function public.email_exists(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from auth.users
    where lower(email) = lower(p_email)
  );
$$;

grant execute on function public.email_exists(text) to anon, authenticated;
