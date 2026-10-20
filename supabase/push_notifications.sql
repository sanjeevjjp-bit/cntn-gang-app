-- CNTN push notifications: run this AFTER your existing schema.sql and phase2.sql.
-- This adds per-device subscriptions. It does not expose VAPID private keys.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;
revoke all on public.push_subscriptions from authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

drop policy if exists "member manages own push subscriptions" on public.push_subscriptions;
create policy "member manages own push subscriptions"
on public.push_subscriptions
for all to authenticated
using (member_id = (select auth.uid()) and group_id = (select private.my_group_id()))
with check (member_id = (select auth.uid()) and group_id = (select private.my_group_id()));

create index if not exists push_subscriptions_group_id_idx on public.push_subscriptions(group_id);
