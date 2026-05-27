-- Make friendship_state distinguish blocker vs blocked-by
create or replace function public.friendship_state(other uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  r  public.friendships%rowtype;
begin
  if me is null then return 'none'; end if;
  if other = me then return 'self'; end if;
  select * into r from public.friendships
   where user_low = least(me, other) and user_high = greatest(me, other);
  if not found then return 'none'; end if;
  if r.status = 'accepted' then return 'friends'; end if;
  if r.status = 'blocked' then
    if r.requested_by = me then return 'blocked'; end if;
    return 'blocked_by';
  end if;
  if r.status = 'declined' then return 'declined'; end if;
  if r.requested_by = me then return 'outgoing'; else return 'incoming'; end if;
end;
$$;
