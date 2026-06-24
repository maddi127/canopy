-- Lets the (unauthenticated) auth page choose sign-in vs sign-up based on
-- whether the current address is already known. RLS hides addresses from
-- anonymous users, so this SECURITY DEFINER function checks existence across
-- all users and returns ONLY a boolean (no row data is exposed).

create or replace function public.address_exists(p_address text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.addresses
    where formatted_address = p_address
  );
$$;

revoke all on function public.address_exists(text) from public;
grant execute on function public.address_exists(text) to anon, authenticated;
