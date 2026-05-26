-- Add reply_to column to messages
alter table public.messages add column if not exists reply_to uuid references public.messages(id) on delete set null;

-- Drop old functions to allow return type changes
drop function if exists public.send_message_encrypted(uuid, text);
drop function if exists public.send_message_encrypted(uuid, text, uuid);
drop function if exists public.list_messages_decrypted(uuid);

-- Update send_message_encrypted to accept reply_to
create or replace function public.send_message_encrypted(_chat_id uuid, _text text, _reply_to uuid default null)
returns table (
  id         uuid,
  chat_id    uuid,
  sender_id  uuid,
  text       text,
  reply_to   uuid,
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

  insert into public.messages (chat_id, sender_id, text, text_enc, reply_to)
  values (_chat_id, me, '',
          pgp_sym_encrypt(_text, public._popchats_msg_key()),
          _reply_to)
  returning messages.id, messages.created_at into new_id, new_ts;

  return query
    select new_id, _chat_id, me, _text, _reply_to, new_ts;
end;
$$;

grant execute on function public.send_message_encrypted(uuid, text, uuid) to authenticated;

-- Update list_messages_decrypted to include reply_to and reply text
create or replace function public.list_messages_decrypted(_chat_id uuid)
returns table (
  id         uuid,
  chat_id    uuid,
  sender_id  uuid,
  text       text,
  reply_to   uuid,
  reply_text text,
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
         m.reply_to,
         case
           when m.reply_to is not null then (
             select case when r.text_enc is not null
               then pgp_sym_decrypt(r.text_enc, public._popchats_msg_key())
               else r.text end
             from public.messages r where r.id = m.reply_to
           )
           else null
         end as reply_text,
         m.created_at
  from public.messages m
  where m.chat_id = _chat_id
  order by m.created_at asc
  limit 200;
end;
$$;

grant execute on function public.list_messages_decrypted(uuid) to authenticated;

-- Delete message RPC (only sender can delete)
create or replace function public.delete_message(_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  delete from public.messages where id = _message_id and sender_id = me;
end;
$$;

grant execute on function public.delete_message(uuid) to authenticated;

-- RLS policy for delete
drop policy if exists "messages_delete_self" on public.messages;
create policy "messages_delete_self" on public.messages
  for delete using (sender_id = auth.uid());
