# CNTN Gang App — first build

A meme-style mobile-first PWA concept for your private Coffee Na Tea Na group.

## What's included
- Responsive dark meme-style dashboard
- Status actions: I'm coming, At CNTN, Going home, Not decided
- Manual ETA slider
- Browser location-permission test
- Gang list, assemble action, join-code UI, 11 PM check-in preview
- PWA manifest
- Initial Supabase schema draft

## Important: this is a front-end demo
The app currently uses sample members and local React state. It does **not** yet sync phones, send real push notifications, validate invite codes, calculate route ETA, or run an automatic 11 PM task. Those require the Supabase project, secure database policies, a server-side function, and push setup. Do not invite the group to rely on it until these are connected.

## Run locally on a Mac
1. Install Node.js LTS from https://nodejs.org/
2. Unzip this folder and open Terminal inside `cntn-gang-app`.
3. Run:
   ```bash
   npm install
   npm run dev
   ```
4. Open the local URL printed by Vite, usually `http://localhost:5173`.

## Set up Supabase
1. Create a free project at https://supabase.com/
2. Open SQL Editor and review/run `supabase/schema.sql`.
3. Before connecting any client, add membership-aware Row Level Security policies. Keep group data private. Use an Edge Function for invite-code redemption and server-side push sending.
4. Copy Project URL and publishable/anon key into `.env` based on `.env.example`.
5. Implement auth, secure invite redemption, database writes, Realtime subscriptions and push subscriptions. Never expose a `service_role` key in the browser.

## Deploy
Deploy the Vite project to a static host such as Cloudflare Pages or Netlify, using the build command `npm run build` and output directory `dist`. Configure the environment variables in the host dashboard. Keep the repository private if it contains any non-public project details.

## Feature rollout order
1. Connect member login + invite-code validation.
2. Persist statuses and subscribe to Realtime updates.
3. Set the real CNTN destination coordinates.
4. Add opt-in location sharing and route ETA. For a fully free first test, use manual ETA plus a Google Maps directions link; a routing API may require billing setup.
5. Add push notifications via a service worker and server-side sender. On iPhone, users must add the web app to their Home Screen and grant notification permission (iOS/iPadOS 16.4+).
6. Add scheduled 11 PM check-in using a scheduled server function/cron and notification delivery.
7. Add arrival confirmation prompts and clear old location data.

## Privacy defaults
- Location sharing is opt-in, visible to group members only, and should stop when the member marks At CNTN or Going home.
- Store only current status/location, not a permanent location history.
- Use a random invite code and rotate it if it leaks.
- Use Row Level Security and server-side authorization before storing real group data.

## Phase 2 database integration (added)
- `supabase/phase2.sql` adds private invite-code validation, membership-aware RLS, and the actual CNTN coordinates (12.9217333, 77.5809304).
- **Before executing phase2.sql**, replace `REPLACE-WITH-LONG-RANDOM-INVITE-CODE` with your own secret random invite code. Keep it out of public repositories. The SQL stores only a bcrypt hash.
- In Supabase Dashboard → Authentication → Providers, enable anonymous sign-ins.
- Run `schema.sql` then `phase2.sql` in SQL Editor, exactly once. If you already created a group, do not run the group INSERT again.
- `src/supabase.js` provides real authentication, invite redemption, status upsert, group queries and Realtime subscription helpers. **The current demo interface does not yet call these helpers**; wiring the UI is the next development step.
- For safety, SQL restricts reads to same-group members and writes to the member's own status. **Add rate limiting/CAPTCHA before inviting untrusted users**; invite validation alone can be brute-forced without throttling.
- Push notifications, scheduled 11 PM check-in, and real driving/walking route ETA are not yet implemented. Browser geolocation alone is not travel ETA, and reliable background live tracking is limited in PWAs.


## Push notification update

See `README-PUSH-SETUP.md` for VAPID key generation, the SQL migration, Edge Function deployment, free HTTPS hosting, and per-device opt-in. Real push notifications will not work until those setup steps are completed.
