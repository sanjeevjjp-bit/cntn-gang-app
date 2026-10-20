import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, configured } from './supabase';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

const DEST = { lat: 12.9217333, lng: 77.5809304 };
const MAPS_URL = 'https://www.google.com/maps/dir/?api=1&destination=12.9217333%2C77.5809304';
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


  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';

  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      setPushSupported(Capacitor.isPluginAvailable('PushNotifications'));
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
          throw new Error('This APK does not include native push support. Install the newly built CNTN APK first.');
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
          rejectRegistration(new Error(err?.error || 'Firebase registration failed.'));
        });

        try {
          let permission = await PushNotifications.checkPermissions();
          if (permission.receive !== 'granted') {
            permission = await PushNotifications.requestPermissions();
          }
          if (permission.receive !== 'granted') {
            throw new Error('Notification permission was not granted on this device.');
