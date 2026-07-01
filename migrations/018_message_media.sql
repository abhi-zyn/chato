-- =========================================================
-- PopChats — Image/video messages + moderation gate
-- Run once in: Supabase → SQL Editor → New query
-- Idempotent: safe to re-run.
--
-- Media is NOT shown until moderation = 'approved'. An Edge Function
-- (supabase/functions/moderate-media) runs CSAM + nudity checks and flips
-- the status. CSAM scanning is legally mandatory and must never be disabled.
-- =========================================================

alter table public.messages
  add column if not exists media_url   text,
  add column if not exists media_type  text,   -- 'image' | 'video'
  add column if not exists moderation  text not null default 'approved';
-- Text-only messages stay 'approved'; media rows are inserted as 'pending' below.

-- Create a media message (starts 'pending' until moderation clears it).
create or replace function public.send_media_message(
  _chat_id uuid, _media_url text, _media_type text
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare me uuid := auth.uid(); new_id uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if not public.is_chat_member(_chat_id) then raise exception 'not a member'; end if;
  if not public.can_message_chat(_chat_id) then raise exception 'cannot message this chat'; end if;
  if not public.is_adult() then raise exception 'must_be_18'; end if;
  if _media_type not in ('image','video') then raise exception 'bad media_type'; end if;

  insert into public.messages (chat_id, sender_id, text, media_url, media_type, moderation)
  values (_chat_id, me, '', _media_url, _media_type, 'pending')
  returning id into new_id;
  return new_id;
end;
$$;
grant execute on function public.send_media_message(uuid, text, text) to authenticated;

-- Private storage bucket for chat media (serve via signed URLs).
insert into storage.buckets (id, name, public)
values ('chat-media', 'chat-media', false)
on conflict (id) do nothing;

-- Only the uploader may write; path must start with their uid: <uid>/<file>
drop policy if exists "chat_media_insert_own" on storage.objects;
create policy "chat_media_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-media'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "chat_media_read_auth" on storage.objects;
create policy "chat_media_read_auth" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-media');
-- For stricter privacy, drop the broad read policy above and generate
-- short-lived signed URLs server-side instead.
