-- 019_calls_friends_signaling.sql
-- Enforce calls only between friends + lock signaling so only the two call
-- participants can read/write a room. This also fixes ICE/SDP (IP address)
-- leakage to non-participants, since the old policies were world-readable.

-- Parse the two user UUIDs from a 'call:<uuid>_<uuid>' room id.
create or replace function public.signaling_room_uids(_room_id text)
returns uuid[]
language sql
immutable
as $$
  select case
    when _room_id like 'call:%' then (
      select array_agg(x::uuid)
      from unnest(string_to_array(substr(_room_id, 6), '_')) as x
      where x ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    )
    else null
  end;
$$;

create or replace function public.signaling_is_participant(_room_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() = any (coalesce(public.signaling_room_uids(_room_id), array[]::uuid[]));
$$;
grant execute on function public.signaling_is_participant(text) to authenticated;

create or replace function public.signaling_offer_allowed(_room_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when array_length(public.signaling_room_uids(_room_id), 1) = 2
      then public.are_friends((public.signaling_room_uids(_room_id))[1], (public.signaling_room_uids(_room_id))[2])
    else false
  end;
$$;
grant execute on function public.signaling_offer_allowed(text) to authenticated;

-- Optional helper the client can call before dialing.
create or replace function public.can_call(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.are_friends(auth.uid(), other);
$$;
grant execute on function public.can_call(uuid) to authenticated;

-- Replace the world-open signaling policies with participant-scoped ones.
drop policy if exists "signaling_select_all" on public.signaling;
drop policy if exists "signaling_insert_all" on public.signaling;
drop policy if exists "signaling_delete_all" on public.signaling;

create policy "signaling_select_participant" on public.signaling
  for select to authenticated
  using (public.signaling_is_participant(room_id));

create policy "signaling_insert_participant" on public.signaling
  for insert to authenticated
  with check (
    public.signaling_is_participant(room_id)
    and (type <> 'offer' or public.signaling_offer_allowed(room_id))
  );

create policy "signaling_delete_participant" on public.signaling
  for delete to authenticated
  using (public.signaling_is_participant(room_id));
