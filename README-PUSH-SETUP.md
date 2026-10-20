# CNTN Gang App — push-notification update

This project adds the browser-side PWA push subscription flow and a Supabase Edge Function for the **LET'S ASSEMBLE** button. The function sends Web Push to other members who have opted in on their devices.

## Important

- This is a prepared project update, **not a deployment**. The hosting site and Supabase function must be configured in your own accounts before real push alerts work.
- Do not upload `.env`, `node_modules`, or any service-role/private VAPID keys to public repositories.
- Only the VAPID **public** key belongs in `VITE_VAPID_PUBLIC_KEY`. The VAPID private key and Supabase service-role key must be stored as Supabase Edge Function secrets.
- Every member must open the deployed HTTPS URL and enable notifications on each device.
- iPhone: iOS/iPadOS 16.4+ generally requires the web app to be added to the Home Screen before web push notifications are available. Enable notifications after opening the installed Home Screen app.
- Notification delivery is subject to device/browser permission, battery/network settings, and push service availability.
- The 11 PM scheduled check-in is **not** implemented by this update.

## 1. Local setup

1. Unzip the project.
2. Copy `.env.example` to `.env`.
3. Fill `.env` with your existing Supabase project URL and publishable/anon key, plus the VAPID public key created below.
4. In Terminal, inside the project folder:
   ```bash
   npm install
   npm run dev
   ```
   Localhost is fine for interface testing, but real push is best tested on a deployed HTTPS URL.

## 2. Create VAPID keys

On your Mac, from the project folder, run:
```bash
npx --yes web-push generate-vapid-keys
```
Copy the **Public Key** into `.env` as `VITE_VAPID_PUBLIC_KEY`. Keep the **Private Key** private; do not put it in `.env` or the frontend. If the command prompts for a package, allow it to run.

## 3. Add the database table

In Supabase Dashboard → SQL Editor, run `supabase/push_notifications.sql` once, after the existing schema and phase2 policies. It creates the per-device subscription table with RLS.

## 4. Deploy the Edge Function

Install Supabase CLI using the official instructions: https://supabase.com/docs/guides/cli/getting-started

Then from this project folder:
```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set VAPID_PUBLIC_KEY=YOUR_PUBLIC_KEY VAPID_PRIVATE_KEY=YOUR_PRIVATE_KEY VAPID_SUBJECT=mailto:YOUR_EMAIL
supabase functions deploy send-assemble-push
```
The CLI prompts/command above stores keys server-side. Do not commit the values. The function uses the built-in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` environment variables available in Supabase Edge Functions. If your project does not expose one of these automatically, set it through `supabase secrets set` using values from Project Settings → API; never put the service-role key in Vite `.env`.

## 5. Build and deploy the website

Choose a free static host such as Cloudflare Pages or Netlify. For a CLI build:
```bash
npm run build
```
The generated `dist/` folder is the website output. In the host's build settings use:
- Build command: `npm run build`
- Publish/output directory: `dist`

Set these build-time environment variables in the hosting dashboard:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_VAPID_PUBLIC_KEY`

Redeploy after setting them. Use the HTTPS URL provided by the host. Do not use the localhost address as the group link.

## 6. Enable notifications on every phone

1. Open the deployed HTTPS app.
2. Join CNTN (existing members should be recognized in their browser session; a new browser/device may need to join again).
3. Tap the bell or **ENABLE NOTIFICATIONS** and allow browser notifications.
4. Repeat on every phone that should receive alerts.
5. Tap **LET'S ASSEMBLE** from one device. Other opted-in devices should show “☕ CHAI EMERGENCY!” even when the app isn't open.

If no notifications arrive, first check that the other device's browser has notifications enabled, that the subscription row exists in `push_subscriptions`, and that the Edge Function logs show a successful request.

## Privacy and scope

The function sends notifications only to subscriptions belonging to the caller's own CNTN group and excludes the sender's own devices. A device subscription is saved per member and can be revoked from browser settings; stale subscriptions are cleaned up after 404/410 push responses. This version does not add a UI to unsubscribe, and does not schedule the 11 PM reminder.
