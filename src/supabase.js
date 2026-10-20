
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(url && key);
export const supabase = configured ? createClient(url, key) : null;


export async function joinGang(nickname, inviteCode) {
  if (!supabase) throw new Error('Configure Supabase environment variables first.');
  const { data: session } = await supabase.auth.getSession();
  if (!session.session) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
  }
  const { data, error } = await supabase.rpc('join_cntn', { p_name: nickname, p_code: inviteCode });
  if (error) throw error;
  if (!data) throw new Error('Wrong invite code.');
  return true;
}

export async function getGang() {
  const { data: members, error: me } = await supabase.from('members').select('id,group_id,display_name');
  if (me) throw me;
  const { data: statuses, error: se } = await supabase.from('status_updates').select('*');
  if (se) throw se;
  return { members, statuses };
}

export async function updateStatus(status, etaMinutes = null, location = null) {
  const { data: userData, error: ue } = await supabase.auth.getUser();
  if (ue || !userData.user) throw ue || new Error('Sign in first');
  const { data: member, error: me } = await supabase.from('members').select('group_id').eq('id', userData.user.id).single();
  if (me) throw me;
  const sharing = status === 'coming' && location;
  const { error } = await supabase.from('status_updates').upsert({
    member_id: userData.user.id,
    group_id: member.group_id,
    status,
    eta_minutes: status === 'coming' ? etaMinutes : null,
    location_lat: sharing ? location.latitude : null,
    location_lng: sharing ? location.longitude : null,
    location_updated_at: sharing ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'member_id' });
  if (error) throw error;
}

export function subscribeToGang(groupId, onChange) {
  return supabase.channel(`cntn-${groupId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'status_updates', filter: `group_id=eq.${groupId}` }, onChange)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'announcements', filter: `group_id=eq.${groupId}` }, onChange)
    .subscribe();
}
// CNTN build refresh
// Trigger fresh CNTN production build
