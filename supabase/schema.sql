-- CNTN MVP schema (run in Supabase SQL Editor after creating a project)
-- IMPORTANT: do not enable public read access. Group membership must be checked server-side.
create extension if not exists pgcrypto;

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Coffee Na Tea Na',
  invite_code_hash text not null unique,
  destination_lat double precision,
  destination_lng double precision,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key references auth.users(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 32),
  created_at timestamptz not null default now()
);

create type public.cntn_status as enum ('idle', 'coming', 'there', 'home');

create table if not exists public.status_updates (
  member_id uuid primary key references public.members(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  status public.cntn_status not null default 'idle',
  eta_minutes integer check (eta_minutes between 1 and 240),
  -- Store location only while a member explicitly shares it; clear it when they stop sharing.
  location_lat double precision,
  location_lng double precision,
  location_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  member_id uuid references public.members(id) on delete set null,
  kind text not null check (kind in ('assemble','status','arrival_check','night_checkin')),
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.groups enable row level security;
alter table public.members enable row level security;
alter table public.status_updates enable row level security;
alter table public.announcements enable row level security;

-- No permissive policies are added here intentionally.
-- Add membership-aware policies before connecting the client. Never put service_role keys in the browser.
-- For secure invite-code redemption, validate the code in a server-side Edge Function and return a
-- short-lived authenticated session/membership; do not expose invite_code_hash to clients.
-- Enable Realtime for status_updates and announcements in the Supabase dashboard after policies are ready.
