import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, configured } from './supabase';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

const DEST = { lat: 12.9217333, lng: 77.5809304 };
const MAPS_URL = 'https://www.google.com/maps/dir/?api=1&destination=12.9217333%2C77.5809304';
// Latest signed APK, published by the "Build CNTN Android APK" GitHub Action.
const APK_URL = 'https://github.com/sanjeevjjp-bit/cntn-gang-app/releases/latest/download/CNTN.apk';
// Which status buttons also send a push notification to the rest of the gang.
// Options: 'coming', 'there', 'home', 'idle'. Remove one to make it silent.
// (The function only supports 'coming' and 'there' unless extended.)
const NOTIFY_STATUSES = ['coming', 'there'];
const statusLabel = { idle: '👀 Not decided', coming: '🏃 Coming', there: '☕ At CNTN', home: '🏠 Going home' };

export default function LiveApp() {
  const [user, setUser] = useState(null);
  const [member, setMember] = useState(null);
  const [members, setMembers] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [events, setEvents] = useState([]);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [eta, setEta] = useState(10);
  const [msg, setMsg] = useState('Connecting to your private gang…');
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushReady, setPushReady] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);
  const [updateNeeded, setUpdateNeeded] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      const hasNativePush = Capacitor.isPluginAvailable('PushNotifications');
      setPushSupported(hasNativePush);
      // Old APKs were built without the native push plugin: show the update popup.
      if (!hasNativePush) setUpdateNeeded(true);
      return;
    }
    const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator &&
      'PushManager' in window && 'Notification' in window;
    setPushSupported(supported);
    if (!supported) return;
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setPushReady(Boolean(sub)))
      .catch((err) => setMsg(`Push setup: ${err.message}`));
  }, []);

  // Show a message when a push arrives while the app is open (Android hides it otherwise).
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('PushNotifications')) return;
    let handle;
    let cancelled = false;
    PushNotifications.addListener('pushNotificationReceived', (n) => {
      setMsg(`🔔 ${n.title || 'CNTN'}${n.body ? ' — ' + n.body : ''}`);
    }).then((h) => { if (cancelled) h.remove(); else handle = h; }).catch(() => {});
    return () => { cancelled = true; handle?.remove(); };
  }, []);

  function base64UrlToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
  }

  async function enableNotifications() {
    if (!member || !user || !supabase) return;
    setPushBusy(true);
    try {
      if (Capacitor.isNativePlatform()) {
        if (!Capacitor.isPluginAvailable('PushNotifications')) {
          setUpdateNeeded(true);
          setUpdateDismissed(false);
          throw new Error('This app version cannot receive notifications. Please install the new CNTN app.');
        }

        // Android 13+ needs the user to allow notifications before registering.
        let permission = await PushNotifications.checkPermissions();
        if (permission.receive === 'prompt' || permission.receive === 'prompt-with-rationale') {
          permission = await PushNotifications.requestPermissions();
        }
        if (permission.receive !== 'granted') {
          throw new Error('Notifications are blocked. Open phone Settings → Apps → CNTN → Notifications and allow them, then try again.');
        }

        let resolveRegistration;
        let rejectRegistration;
        const registrationResult = new Promise((resolve, reject) => {
          resolveRegistration = resolve;
          rejectRegistration = reject;
        });

        const registrationListener = await PushNotifications.addListener('registration', async ({ value }) => {
          try {
            const { error } = await supabase.from('device_push_tokens').upsert({
              member_id: user.id,
              group_id: member.group_id,
              token: value,
              platform: 'android',
              updated_at: new Date().toISOString()
            }, { onConflict: 'token' });
            if (error) throw error;
            setPushReady(true);
            setMsg('🔔 Android notifications enabled on this phone. Ask each gang member to enable them too.');
            resolveRegistration();
          } catch (err) {
            rejectRegistration(err);
          }
        });

        const errorListener = await PushNotifications.addListener('registrationError', (err) => {
          console.error('CNTN FCM REGISTRATION ERROR:', JSON.stringify(err));
          rejectRegistration(new Error(JSON.stringify(err)));
        });

        try {
          if (Capacitor.getPlatform() === 'android') {
            await PushNotifications.createChannel({
              id: 'cntn_alerts',
              name: 'CNTN Alerts',
              description: 'Calls to assemble the CNTN gang',
              importance: 5,
              visibility: 1,
              sound: 'default'
            });
          }

          await PushNotifications.register();
          await Promise.race([
            registrationResult,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase registration timed out. Check your internet connection and try again.')), 20000))
          ]);
        } finally {
          await registrationListener.remove();
          await errorListener.remove();
        }
        return;
      }

      if (!pushSupported) {
        throw new Error('This browser does not support web push. Try a current Chrome/Edge browser on Android, or install CNTN on the iPhone Home Screen first.');
      }
      if (!vapidPublicKey) {
        throw new Error('Web push is not configured: VITE_VAPID_PUBLIC_KEY is missing.');
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notification permission was not granted on this device.');
      const registration = await navigator.serviceWorker.register('/sw.js');
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(vapidPublicKey)
        });
      }
      const { error } = await supabase.from('push_subscriptions').upsert({
        member_id: user.id,
        group_id: member.group_id,
        endpoint: subscription.endpoint,
        subscription: subscription.toJSON(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'endpoint' });
      if (error) throw error;
      setPushReady(true);
      setMsg('🔔 Notifications enabled on this device. Ask each gang member to enable them on their own phone too.');
    } catch (err) {
      setMsg(`Could not enable notifications: ${err?.message || String(err)}`);
    } finally {
      setPushBusy(false);
    }
  }

  const refresh = useCallback(async (userId = user?.id) => {
    if (!supabase || !userId) return;
    const { data: memberRows, error: memberError } = await supabase
      .from('members').select('id,group_id,display_name,created_at').order('created_at', { ascending: true });
    if (memberError) { setMsg(`Members: ${memberError.message}`); return; }
    const mine = (memberRows || []).find((m) => m.id === userId) || null;
    setMember(mine);
    setMembers(memberRows || []);
    if (!mine) { setStatuses([]); setEvents([]); return; }
    const [statusResult, eventResult] = await Promise.all([
      supabase.from('status_updates').select('member_id,group_id,status,eta_minutes,updated_at').eq('group_id', mine.group_id),
      supabase.from('announcements').select('id,group_id,member_id,kind,message,created_at').eq('group_id', mine.group_id).order('created_at', { ascending: false }).limit(20),
    ]);
    if (statusResult.error) setMsg(`Statuses: ${statusResult.error.message}`); else setStatuses(statusResult.data || []);
    if (eventResult.error) setMsg(`Activity: ${eventResult.error.message}`); else setEvents(eventResult.data || []);
  }, [user?.id]);

  useEffect(() => {
    let alive = true;
    async function boot() {
      if (!configured || !supabase) { setMsg('Add your Supabase URL and publishable key to .env, then restart Vite.'); return; }
      const { data, error } = await supabase.auth.getSession();
      if (error) { setMsg(error.message); return; }
      let session = data.session;
      if (!session) {
        const signed = await supabase.auth.signInAnonymously();
        if (signed.error) { setMsg(`Anonymous sign-in failed: ${signed.error.message}`); return; }
        session = signed.data.session;
      }
      if (alive) setUser(session?.user || null);
    }
    boot();
    const { data: authListener } = supabase?.auth.onAuthStateChange((_event, session) => { if (alive) setUser(session?.user || null); }) || { data: { subscription: null } };
    return () => { alive = false; authListener?.subscription?.unsubscribe(); };
  }, []);

  useEffect(() => { if (user) refresh(user.id); }, [user, refresh]);

  useEffect(() => {
    if (!member?.group_id || !supabase) return;
    const channel = supabase.channel(`cntn-live-${member.group_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'status_updates', filter: `group_id=eq.${member.group_id}` }, () => refresh())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'announcements', filter: `group_id=eq.${member.group_id}` }, () => refresh())
      .subscribe();
    const timer = setInterval(() => refresh(), 30000);
    return () => { clearInterval(timer); supabase.removeChannel(channel); };
  }, [member?.group_id, refresh]);

  const myStatus = statuses.find((s) => s.member_id === user?.id);
  const counts = useMemo(() => ({ there: statuses.filter((s) => s.status === 'there').length, coming: statuses.filter((s) => s.status === 'coming').length }), [statuses]);

  async function join(e) {
    e.preventDefault();
    if (!supabase || !user) { setMsg('Still connecting. Please wait a moment and try again.'); return; }
    setBusy(true);
    const { data, error } = await supabase.rpc('join_cntn', { p_name: name.trim(), p_code: code });
    if (error) setMsg(`Couldn't join: ${error.message}`);
    else if (!data) setMsg('That invite code did not match. Check it and try again.');
    else { setMsg('Welcome to the gang ☕'); setCode(''); await refresh(user.id); }
    setBusy(false);
  }

  async function updateStatus(nextStatus) {
    if (!member || !user) return;
    setBusy(true);
    const now = new Date().toISOString();
    const { error } = await supabase.from('status_updates').upsert({
      member_id: user.id, group_id: member.group_id, status: nextStatus,
      eta_minutes: nextStatus === 'coming' ? Number(eta) : null,
      location_lat: null, location_lng: null, location_updated_at: null, updated_at: now,
    }, { onConflict: 'member_id' });
    if (error) setMsg(`Status update failed: ${error.message}`);
    else {
      const message = nextStatus === 'coming' ? `${member.display_name} is coming ☕ (~${eta} min)` : nextStatus === 'there' ? `${member.display_name} reached CNTN ☕` : nextStatus === 'home' ? `${member.display_name} is going home 🏠` : `${member.display_name} is undecided 👀`;
      const { error: announcementError } = await supabase.from('announcements').insert({ group_id: member.group_id, member_id: user.id, kind: 'status', message });
      setMsg(announcementError ? `Status saved; activity message failed: ${announcementError.message}` : `Status updated: ${statusLabel[nextStatus]}`);
      // Tell the rest of the gang by push (only for the statuses in NOTIFY_STATUSES).
      if (NOTIFY_STATUSES.includes(nextStatus)) {
        supabase.functions.invoke('send-assemble-push', { body: { kind: nextStatus, eta: Number(eta) } })
          .then(({ data, error: pushError }) => {
            if (pushError) setMsg(`Status saved, but the notification failed: ${pushError.message}`);
            else if (data?.totalSent === 0) setMsg(`Status updated: ${statusLabel[nextStatus]} (nobody else has notifications enabled yet)`);
          })
          .catch(() => {});
      }
      await refresh(user.id);
    }
    setBusy(false);
  }

  async function assemble() {
    if (!member || !user || !supabase) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-assemble-push', { body: {} });
      if (error) throw error;
      setMsg(data?.message || '📣 Assemble request sent. Only members who enabled notifications can receive push alerts.');
      await refresh(user.id);
    } catch (err) {
      setMsg(`Couldn't send push notification: ${err?.message || String(err)}. Check that the push Edge Function is deployed and its secrets are set.`);
    } finally {
      setBusy(false);
    }
  }

  function getLocation() {
    if (!navigator.geolocation) { setMsg('Location is unavailable in this browser. You can still use a manual ETA.'); return; }
    setSharing(true);
    navigator.geolocation.getCurrentPosition((p) => {
      setPosition({ lat: p.coords.latitude, lng: p.coords.longitude }); setSharing(false);
      setMsg('📍 Location checked on this device only. No GPS coordinates are uploaded. Use Maps for road directions and set a manual ETA.');
    }, (e) => { setSharing(false); setMsg(e.code === 1 ? 'Location permission denied. Manual ETA still works.' : `Could not read location: ${e.message}`); }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 });
  }
  const distance = position ? Math.round(6371 * 2 * Math.asin(Math.sqrt(Math.sin((DEST.lat - position.lat) * Math.PI / 360) ** 2 + Math.cos(position.lat * Math.PI / 180) * Math.cos(DEST.lat * Math.PI / 180) * Math.sin((DEST.lng - position.lng) * Math.PI / 360) ** 2)) * 10) / 10 : null;

  return <main className="app-shell">
    {updateNeeded && !updateDismissed && <div role="dialog" aria-modal="true" aria-label="App update required" style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#241d16', border: '1px solid #6b5238', borderRadius: 20, padding: 22, maxWidth: 380, width: '100%', color: '#f5ece0', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
        <div style={{ fontSize: 36, textAlign: 'center' }}>🔔</div>
        <h3 style={{ margin: '8px 0', textAlign: 'center', fontSize: 20 }}>Update required ☕</h3>
        <p style={{ fontSize: 13, lineHeight: 1.5, color: '#d8cbb9', margin: '0 0 10px' }}>This version of CNTN cannot receive chai-call notifications. Please install the new app once.</p>
        <ol style={{ fontSize: 12.5, lineHeight: 1.6, color: '#d8cbb9', paddingLeft: 18, margin: '0 0 14px' }}>
          <li>Tap <strong>Download new app</strong> below.</li>
          <li>Open the downloaded file and tap Install. If Android asks, allow "install unknown apps".</li>
          <li>If it says "App not installed", first uninstall the old CNTN app, then install again.</li>
          <li>Open the new app, join with your nickname + gang code, and tap <strong>Enable notifications</strong>.</li>
        </ol>
        <a href={APK_URL} target="_blank" rel="noreferrer" className="assemble-button" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>⬇️ DOWNLOAD NEW APP</a>
        <button type="button" className="location-button" style={{ marginTop: 10 }} onClick={() => setUpdateDismissed(true)}>Later</button>
      </div>
    </div>}
    <header className="topbar"><div className="brand-mark">☕</div><div className="brand-copy"><div className="eyebrow">PRIVATE GANG APP <span className="live-dot" /></div><h1>CNTN ☕</h1><p>Coffee Naa Tea Naa · Chai Attendance</p></div><button className="icon-button" aria-label="Notifications" onClick={enableNotifications}>🔔</button></header>
    <section className="hero-card"><div className="hero-stamp">🔥 DAILY ADDICTION</div><h2>Your gang.<br/><span>Your adda.</span></h2><p>Attendance is optional. Excuses are mandatory.</p><div className="hero-stats"><div><strong>{counts.there}</strong><span>at CNTN</span></div><div className="stat-divider"/><div><strong>{counts.coming}</strong><span>en route</span></div><div className="stat-divider"/><div><strong>{members.length}</strong><span>in the gang</span></div></div></section>
    {!member ? <section className="section"><span className="section-kicker">SECRET CHAI SOCIETY</span><h3>Join the gang 🔐</h3><p style={{ color: '#b9ad9e', fontSize: 12 }}>Nickname + private invite code. No email needed.</p><form onSubmit={join}><input className="name-input" required minLength="2" maxLength="32" placeholder="Your nickname" value={name} onChange={(e) => setName(e.target.value)} /><input className="name-input" style={{ marginTop: 10 }} required minLength="12" maxLength="128" placeholder="Private invite code" value={code} onChange={(e) => setCode(e.target.value)} /><button className="assemble-button" disabled={busy}>{busy ? 'CONNECTING…' : 'JOIN THE CHAI COUNCIL ☕'}</button></form></section> : <>
      <section className="section"><div className="section-heading"><div><span className="section-kicker">HELLO, {member.display_name.toUpperCase()}</span><h3>Where you at, bro?</h3></div><span className="tiny-pill"><span className="green-dot"/> LIVE</span></div><div className="status-grid"><button className="status-action action-coming" disabled={busy} onClick={() => updateStatus('coming')}>🏃 <span>I'm coming</span><small>ETA: {eta} min</small></button><button className="status-action action-there" disabled={busy} onClick={() => updateStatus('there')}>☕ <span>At CNTN</span><small>Attendance marked</small></button><button className="status-action action-home" disabled={busy} onClick={() => updateStatus('home')}>🏠 <span>Going home</span><small>Bye bye</small></button><button className="status-action action-idle" disabled={busy} onClick={() => updateStatus('idle')}>👀 <span>Not decided</span><small>Typical</small></button></div><div className="eta-panel"><div className="eta-title"><strong>ETA: {eta} min</strong></div><input className="eta-slider" aria-label="ETA minutes" type="range" min="1" max="90" value={eta} onChange={(e) => setEta(Number(e.target.value))}/><div className="slider-labels"><span>1 min</span><span>90 min</span></div><button className="location-button" onClick={getLocation} disabled={sharing}>{sharing ? 'Checking GPS…' : '📍 Check my location (opt-in)'}</button>{distance !== null && <p style={{ fontSize: 11, color: '#b9ad9e' }}>Straight-line distance: ~{distance} km (not road ETA). Coordinates stay on this phone.</p>}<a href={MAPS_URL} target="_blank" rel="noreferrer" className="location-button" style={{ textDecoration: 'none' }}>🗺️ Open route to CNTN in Maps</a></div></section>
      <section className="section push-panel">
        <span className="section-kicker">PHONE NOTIFICATIONS</span>
        <h3>Don't miss the chai call 🔔</h3>
        <p style={{ color: '#b9ad9e', fontSize: 12 }}>Enable push alerts on this device. Each gang member must enable them on their own phone.</p>
        <button className="location-button" onClick={enableNotifications} disabled={pushBusy || pushReady || !member}>
          {pushBusy ? 'ENABLING…' : pushReady ? '✓ NOTIFICATIONS ENABLED' : '🔔 ENABLE NOTIFICATIONS'}
        </button>
        {!pushSupported && <p style={{ color: '#ffbd78', fontSize: 11 }}>{Capacitor.isNativePlatform() ? 'This APK needs the native notification update. Install the latest CNTN APK to enable Android push alerts.' : 'Push is supported only in compatible browsers. On iPhone, add CNTN to the Home Screen first.'}</p>}
      </section>
      <section className="section"><div className="section-heading"><div><span className="section-kicker">THE USUAL SUSPECTS</span><h3>Gang status</h3></div></div><div className="people-list">{members.map((m, i) => { const s = statuses.find((x) => x.member_id === m.id); return <article className="person-row" key={m.id}><div className={`avatar avatar-${i % 4}`}>{m.display_name?.[0]?.toUpperCase() || '?'}</div><div className="person-main"><div className="person-name">{m.display_name}{m.id === user?.id ? ' (you)' : ''}</div><div className="person-note">{s?.updated_at ? 'Updated ' + new Date(s.updated_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : 'No status yet'}</div></div><div className="person-right"><span className={'status-chip ' + (s?.status || 'idle')}>{statusLabel[s?.status || 'idle']}</span>{s?.status === 'coming' && <small>~{s.eta_minutes} min (self-reported)</small>}</div></article>; })}</div><button className="assemble-button" disabled={busy} onClick={assemble}>📣 LET'S ASSEMBLE</button></section>
      <section className="night-card"><div className="moon">🌙</div><div className="night-copy"><span className="section-kicker">11 PM CHECK-IN</span><h3>Bro… still at CNTN?</h3><p>Push is available after setup; the 11 PM automatic check-in is a separate feature and is not configured yet.</p></div></section>
      <section className="section"><span className="section-kicker">GANG ACTIVITY · LIVE</span><div className="people-list" style={{ marginTop: 10 }}>{events.length ? events.map((e) => <div className="person-row" key={e.id} style={{ fontSize: 12 }}><div style={{ flex: 1 }}>{e.message}</div><small style={{ color: '#a99d8e' }}>{new Date(e.created_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</small></div>) : <div className="person-row">No activity yet. Summon the gang!</div>}</div></section>
    </>}
    {msg && <section className="notice-card">🔔 <span style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{msg}</span></section>}
    <footer>🔒 Invite only · GPS opt-in · GPS coordinates are not uploaded</footer>
  </main>;
}
