-- RUN AFTER schema.sql. Designed for a single private CNTN group.
-- Set the invite code below to a long random code before running; do not share publicly.
create schema if not exists private;

-- Ensure all tables are denied to unauthenticated API requests.
revoke all on public.groups, public.members, public.status_updates, public.announcements from anon;
revoke all on public.groups from authenticated;
revoke all on public.members, public.status_updates, public.announcements from authenticated;
grant select on public.members, public.status_updates, public.announcements to authenticated;
grant insert on public.announcements to authenticated;
grant insert, update on public.status_updates to authenticated;

-- Store one group; replace the placeholder with a random 16+ character secret.
insert into public.groups (name, invite_code_hash, destination_lat, destination_lng)
values ('Coffee Naa Tea Naa', crypt('REPLACE-WITH-YOUR-PRIVATE-INVITE-CODE', gen_salt('bf')), 12.9217333, 77.5809304);

-- Security-definer functions avoid circular member RLS checks.
create or replace function private.my_group_id()
returns uuid language sql stable security definer set search_path = '' as $$
 select group_id from public.members where id = (select auth.uid()) limit 1
$$;
revoke all on function private.my_group_id() from public;
grant usage on schema private to authenticated;
grant execute on function private.my_group_id() to authenticated;

-- Secure code redemption; invite code is checked server-side, never returned to browser.
create or replace function public.join_cntn(p_name text, p_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target_id uuid;
begin
 if auth.uid() is null then raise exception 'Sign in first'; end if;
 if length(trim(p_name)) not between 1 and 32 then raise exception 'Invalid nickname'; end if;
 if length(p_code) > 128 then raise exception 'Invalid code'; end if;
 if exists(select 1 from public.members where id = auth.uid()) then return true; end if;
 select id into target_id from public.groups
 where invite_code_hash = public.crypt(p_code, invite_code_hash) limit 1;
 if target_id is null then return false; end if;
 insert into public.members (id, group_id, display_name)
 values (auth.uid(), target_id, trim(p_name));
 return true;
end $$;
revoke all on function public.join_cntn(text,text) from public, anon;
grant execute on function public.join_cntn(text,text) to authenticated;

create policy "members can see own gang" on public.members for select to authenticated
 using (group_id = (select private.my_group_id()));
create policy "members can see gang statuses" on public.status_updates for select to authenticated
 using (group_id = (select private.my_group_id()));
create policy "members can insert own status" on public.status_updates for insert to authenticated
 with check (member_id = (select auth.uid()) and group_id = (select private.my_group_id()));
create policy "members can update own status" on public.status_updates for update to authenticated
 using (member_id = (select auth.uid()) and group_id = (select private.my_group_id()))
 with check (member_id = (select auth.uid()) and group_id = (select private.my_group_id()));
create policy "members can see gang announcements" on public.announcements for select to authenticated
 using (group_id = (select private.my_group_id()));
create policy "members can post gang announcements" on public.announcements for insert to authenticated
 with check (member_id = (select auth.uid()) and group_id = (select private.my_group_id())
 and kind in ('assemble','status') and char_length(message) <= 280);

-- Protect group_id integrity on status updates by using the member's own group only.
-- No client writes to members/groups are permitted; only join_cntn can add members.
-- Enable Realtime publication in Dashboard for status_updates and announcements.
-- Rate limit join attempts via Edge Function/CAPTCHA before exposing to untrusted users.
