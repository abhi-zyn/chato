-- =========================================================
-- PopChats — clean up duplicate DMs and harden get_or_create_dm
-- Run once in: Supabase → SQL Editor → New query
-- =========================================================

-- 1. For each pair of users with multiple non-stranger chats, keep the chat
--    that has the most recent message and migrate any stray messages over.
do $$
declare
  rec record;
begin
  for rec in
    with pairs as (
      select cm1.chat_id, least(cm1.user_id, cm2.user_id) as a, greatest(cm1.user_id, cm2.user_id) as b
      from chat_members cm1
      join chat_members cm2
        on cm1.chat_id = cm2.chat_id and cm1.user_id < cm2.user_id
      join chats c on c.id = cm1.chat_id and c.is_stranger = false
    ),
    counted as (
      select a, b, array_agg(chat_id order by chat_id) as chat_ids, count(*) as n
      from pairs group by a, b having count(*) > 1
    )
    select * from counted
  loop
    -- Pick the keeper: the chat with the latest message (or first if none have)
    declare
      keeper uuid;
      others uuid[];
    begin
      select rec.chat_ids[1] into keeper;
      select coalesce(
        (select chat_id from messages
          where chat_id = any(rec.chat_ids)
          order by created_at desc limit 1),
        rec.chat_ids[1]
      ) into keeper;
      others := array(select unnest(rec.chat_ids) except select keeper);
      -- Move messages onto the keeper, then drop the duplicate chats.
      update messages set chat_id = keeper where chat_id = any(others);
      delete from chats where id = any(others);
    end;
  end loop;
end $$;

-- 2. Add a partial unique index so two users can never have more than one
--    non-stranger DM going forward. We hash the (lesser, greater) pair.
create or replace function public.dm_pair_key(_chat_id uuid)
returns text
language sql
stable
as $$
  with users as (
    select user_id from public.chat_members where chat_id = _chat_id
  ),
  cnt as (select count(*) as n from users),
  ord as (select min(user_id) as a, max(user_id) as b from users)
  select case
    when (select n from cnt) = 2 then concat((select a from ord)::text, ':', (select b from ord)::text)
    else null
  end;
$$;

-- 3. Tighten the RPC: take a row-level lock on a per-pair advisory lock so
--    two simultaneous calls can't both insert.
create or replace function public.get_or_create_dm(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me            uuid := auth.uid();
  existing_chat uuid;
  new_chat_id   uuid;
  lock_a        uuid;
  lock_b        uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if other_user_id = me then raise exception 'cannot DM yourself'; end if;

  -- deterministic pair ordering for advisory lock
  if me < other_user_id then lock_a := me; lock_b := other_user_id;
  else lock_a := other_user_id; lock_b := me; end if;
  perform pg_advisory_xact_lock(hashtext(lock_a::text || ':' || lock_b::text));

  select c.id into existing_chat
  from chats c
  where c.is_stranger = false
    and (select count(*) from chat_members cm where cm.chat_id = c.id) = 2
    and exists (select 1 from chat_members where chat_id = c.id and user_id = me)
    and exists (select 1 from chat_members where chat_id = c.id and user_id = other_user_id)
  limit 1;

  if existing_chat is not null then return existing_chat; end if;

  insert into chats(is_stranger) values (false) returning id into new_chat_id;
  insert into chat_members(chat_id, user_id) values (new_chat_id, me);
  insert into chat_members(chat_id, user_id) values (new_chat_id, other_user_id);
  return new_chat_id;
end;
$$;

grant execute on function public.get_or_create_dm(uuid) to authenticated;
