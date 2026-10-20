import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in first." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY")!;
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY")!;
  const subject = Deno.env.get("VAPID_SUBJECT") || "mailto:cntn-admin@example.com";
  if (!supabaseUrl || !anonKey || !serviceRole || !publicKey || !privateKey) {
    return json({ error: "Push function secrets are incomplete." }, 500);
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "Invalid session." }, 401);

  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: member, error: memberError } = await admin
    .from("members")
    .select("id,group_id,display_name")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (memberError || !member) return json({ error: "You must join the CNTN gang first." }, 403);

  webpush.setVapidDetails(subject, publicKey, privateKey);

  const message = `${member.display_name} says ASSEMBLE! ☕`;
  const { error: eventError } = await admin.from("announcements").insert({
    group_id: member.group_id,
    member_id: member.id,
    kind: "assemble",
    message,
  });
  if (eventError) return json({ error: `Could not post assemble event: ${eventError.message}` }, 500);

  const { data: subscriptions, error: subError } = await admin
    .from("push_subscriptions")
    .select("id,member_id,endpoint,subscription")
    .eq("group_id", member.group_id)
    .neq("member_id", member.id);
  if (subError) return json({ error: `Could not load subscriptions: ${subError.message}` }, 500);

  let sent = 0;
  let failed = 0;
  const expired: string[] = [];
  const payload = JSON.stringify({
    title: "☕ CHAI EMERGENCY!",
    body: `${member.display_name} is calling the gang to CNTN. Assemble now!`,
    url: "/",
    tag: `cntn-assemble-${Date.now()}`,
  });

  await Promise.all((subscriptions || []).map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, payload, { TTL: 60 * 60 });
      sent++;
    } catch (err) {
      failed++;
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) expired.push(row.id);
      console.error("Push delivery failed", statusCode || "", String(err));
    }
  }));

  if (expired.length) {
    await admin.from("push_subscriptions").delete().in("id", expired);
  }

  return json({
    ok: true,
    sent,
    failed,
    message: sent
      ? `📣 Assemble sent to ${sent} subscribed device${sent === 1 ? "" : "s"}.`
      : "📣 Assemble posted, but no other members have enabled notifications yet.",
  });
});
