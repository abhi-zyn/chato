-- Block/unblock RPCs + stranger picker excludes friends/blocked

-- Block user
create or replace function public.block_user(other uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); lo uuid; hi uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if other = me then raise exception 'cannot block yourself'; end if;
  lo := least(me, other); hi := greatest(me, other);
  insert into public.friendships (user_low, user_high, requested_by, status)
  values (lo, hi, me, 'blocked')
  on conflict (user_low, user_high) do update
    set status = 'blocked', requested_by = me, updated_at = now();
end;
$$;
grant execute on function public.block_user(uuid) to authenticated;

-- Unblock user
create or replace function public.unblock_user(other uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); lo uuid; hi uuid;
  r public.friendships%rowtype;
begin
  if me is null then raise exception 'not authenticated'; end if;
  lo := least(me, other); hi := greatest(me, other);
  select * into r from public.friendships where user_low = lo and user_high = hi and status = 'blocked';
  if not found then return; end if;
  if r.requested_by <> me then raise exception 'you did not block this user'; end if;
  delete from public.friendships where user_low = lo and user_high = hi;
end;
$$;
grant execute on function public.unblock_user(uuid) to authenticated;

-- pick_random_stranger: exclude friends + blocked
create or replace function public.pick_random_stranger()
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); picked uuid;
begin
  if me is null then return null; end if;
  select p.id into picked from public.profiles p
   where p.id <> me and p.online = true
     and not exists (
       select 1 from public.friendships f
        where f.user_low = least(me, p.id) and f.user_high = greatest(me, p.id)
          and f.status in ('accepted','blocked'))
   order by random() limit 1;
  if picked is null then
    select p.id into picked from public.profiles p
     where p.id <> me
       and not exists (
         select 1 from public.friendships f
          where f.user_low = least(me, p.id) and f.user_high = greatest(me, p.id)
            and f.status in ('accepted','blocked'))
     order by random() limit 1;
  end if;
  return picked;
end;
$$;
grant execute on function public.pick_random_stranger() to authenticated;
