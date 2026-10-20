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
