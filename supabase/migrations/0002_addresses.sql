-- Introduce an addresses ("homes") table and have projects reference it,
-- so one home can own many projects. Run after 0001_init.sql.

-- ── addresses ────────────────────────────────────────────────────────────────
create table if not exists public.addresses (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users (id) on delete cascade,
  formatted_address text        not null,
  lat               double precision,
  lng               double precision,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- one row per (user, address) so we can find-or-create cleanly
create unique index if not exists addresses_user_formatted_key
  on public.addresses (user_id, formatted_address);
create index if not exists addresses_user_id_idx on public.addresses (user_id);

drop trigger if exists addresses_set_updated_at on public.addresses;
create trigger addresses_set_updated_at
  before update on public.addresses
  for each row execute function public.set_updated_at();

alter table public.addresses enable row level security;

drop policy if exists "select own addresses" on public.addresses;
create policy "select own addresses" on public.addresses
  for select using (auth.uid() = user_id);

drop policy if exists "insert own addresses" on public.addresses;
create policy "insert own addresses" on public.addresses
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own addresses" on public.addresses;
create policy "update own addresses" on public.addresses
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "delete own addresses" on public.addresses;
create policy "delete own addresses" on public.addresses
  for delete using (auth.uid() = user_id);

-- ── projects.address (text) -> projects.address_id (fk) ───────────────────────
alter table public.projects
  add column if not exists address_id uuid references public.addresses (id) on delete set null;

create index if not exists projects_address_id_idx on public.projects (address_id);

-- Backfill: create an address row for each distinct existing project address,
-- then point the project at it. Safe to run even with no existing data.
insert into public.addresses (user_id, formatted_address)
select distinct user_id, address
from public.projects
where address is not null and address <> ''
on conflict (user_id, formatted_address) do nothing;

update public.projects p
set address_id = a.id
from public.addresses a
where p.address_id is null
  and p.address is not null
  and a.user_id = p.user_id
  and a.formatted_address = p.address;

-- Drop the old text column now that data is migrated.
alter table public.projects drop column if exists address;
