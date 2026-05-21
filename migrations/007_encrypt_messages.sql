-- =========================================================
-- PopChats — Server-side encryption-at-rest for messages
-- Run once in: Supabase → SQL Editor → New query
-- Idempotent: safe to re-run.
--
-- Threat model: hides plaintext from anyone reading the
-- messages table directly. The key lives inside a
-- SECURITY DEFINER function the API role cannot read source
-- of. NOT end-to-end: the server can decrypt anything.
--
-- IMPORTANT: change POPCHATS_MSG_PASSPHRASE below to a long
-- random string you generated yourself before going to prod.
-- Once set, do NOT change it — old messages become unreadable.
-- =========================================================

create extension if not exists pgcrypto with schema extensions;

-- Add ciphertext column. Old plaintext rows keep their `text`.
alter table public.messages
  add column if not exists text_enc bytea;

-- Allow `text` to be empty string (existing NOT NULL stays).
-- New encrypted rows store '' in text and the bytes in text_enc.

-- ---------- master passphrase ----------
-- This function body is owned by 'postgres' and runs SECURITY DEFINER.
-- Replace the literal below with your own random 32+ char passphrase.
create or replace function public._popchats_msg_key()
returns text
language sql
immutable
security definer
set search_path = public, extensions
as $$
  select 'CHANGE_ME_TO_A_LONG_RANDOM_PASSPHRASE_AT_LEAST_32_CHARS'::text;
$$;

-- Lock down: only postgres role should read the source. Authenticated
-- can EXECUTE but cannot inspect the literal via pg_get_functiondef
-- without superuser. Revoke explicit access just in case.
revoke all on function public._popchats_msg_key() from public, authenticated, anon;

-- ---------- send (encrypt-on-insert) ----------
create or replace function public.send_message_encrypted(_chat_id uuid, _text text)
returns table (
  id         uuid,
  chat_id    uuid,
  sender_id  uuid,
  text       text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
  new_id uuid;
  new_ts timestamptz;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if not public.is_chat_member(_chat_id) then raise exception 'not a member'; end if;
  if not public.can_message_chat(_chat_id) then raise exception 'cannot message this chat'; end if;
  if _text is null or length(btrim(_text)) = 0 then raise exception 'empty message'; end if;

  insert into public.messages (chat_id, sender_id, text, text_enc)
  values (_chat_id, me, '',
          pgp_sym_encrypt(_text, public._popchats_msg_key()))
  returning messages.id, messages.created_at into new_id, new_ts;

  return query
    select new_id, _chat_id, me, _text, new_ts;
end;
$$;

grant execute on function public.send_message_encrypted(uuid, text) to authenticated;

-- ---------- read (decrypt-on-select) ----------
create or replace function public.list_messages_decrypted(_chat_id uuid)
returns table (
  id         uuid,
  chat_id    uuid,
  sender_id  uuid,
  text       text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  if not public.is_chat_member(_chat_id) then raise exception 'not a member'; end if;

  return query
  select m.id, m.chat_id, m.sender_id,
         case
           when m.text_enc is not null
             then pgp_sym_decrypt(m.text_enc, public._popchats_msg_key())
           else m.text
         end as text,
         m.created_at
  from public.messages m
  where m.chat_id = _chat_id
  order by m.created_at asc
  limit 200;
end;
$$;

grant execute on function public.list_messages_decrypted(uuid) to authenticated;

-- ---------- decrypt one (used by realtime callback) ----------
create or replace function public.decrypt_message_text(_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  m record;
begin
  select messages.id, messages.chat_id, messages.text, messages.text_enc
    into m
    from public.messages
   where messages.id = _id;
  if not found then raise exception 'not found'; end if;
  if not public.is_chat_member(m.chat_id) then raise exception 'not a member'; end if;
  if m.text_enc is not null then
    return pgp_sym_decrypt(m.text_enc, public._popchats_msg_key());
  else
    return m.text;
  end if;
end;
$$;

grant execute on function public.decrypt_message_text(uuid) to authenticated;

-- ---------- last-message preview for chat list ----------
create or replace function public.last_message_preview(_chat_id uuid)
returns table (text text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare me uuid := auth.uid();
begin
  if me is null then return; end if;
  if not public.is_chat_member(_chat_id) then return; end if;

  return query
  select case
           when m.text_enc is not null
             then pgp_sym_decrypt(m.text_enc, public._popchats_msg_key())
           else m.text
         end as text,
         m.created_at
  from public.messages m
  where m.chat_id = _chat_id
  order by m.created_at desc
  limit 1;
end;
$$;

grant execute on function public.last_message_preview(uuid) to authenticated;
