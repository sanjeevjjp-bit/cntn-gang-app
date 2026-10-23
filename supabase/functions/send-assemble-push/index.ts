
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function pemToBytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function getFirebaseAccessToken(serviceAccount: {
  client_email: string;
  private_key: string;
  token_uri?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const claims = base64url(
    new TextEncoder().encode(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: serviceAccount.token_uri ||
        "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })),
  );

  const unsigned = `${header}.${claims}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsigned),
  );

  const assertion = `${unsigned}.${base64url(new Uint8Array(signature))}`;
  const tokenResponse = await fetch(
    serviceAccount.token_uri || "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    },
  );

  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error(
      `Firebase OAuth failed: ${JSON.stringify(tokenData)}`,
    );
  }

  return tokenData.access_token as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in first." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject =
    Deno.env.get("VAPID_SUBJECT") || "mailto:cntn-admin@example.com";
  const firebaseSecret = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");

  if (
    !supabaseUrl || !anonKey || !serviceRole ||
    !publicKey || !privateKey || !firebaseSecret
  ) {
    return json({ error: "Push function secrets are incomplete." }, 500);
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } =
    await authClient.auth.getUser(token);
  if (userError || !userData.user) {
    return json({ error: "Invalid session." }, 401);
  }

  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: member, error: memberError } = await admin
    .from("members")
    .select("id,group_id,display_name")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (memberError || !member) {
    return json({ error: "You must join the CNTN gang first." }, 403);
  }

  let serviceAccount: {
    project_id: string;
    client_email: string;
    private_key: string;
    token_uri?: string;
  };

  try {
    serviceAccount = JSON.parse(firebaseSecret);
    if (
      !serviceAccount.project_id ||
      !serviceAccount.client_email ||
      !serviceAccount.private_key
    ) {
      throw new Error("Missing project_id, client_email, or private_key");
    }
  } catch {
    return json({
      error: "FIREBASE_SERVICE_ACCOUNT is not valid service-account JSON.",
    }, 500);
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);

  // What kind of alert is this? "assemble" (default), "coming" or "there".
  const requestBody = await req.json().catch(() => ({}));
  const kind = ["assemble", "coming", "there"].includes(requestBody?.kind)
    ? (requestBody.kind as "assemble" | "coming" | "there")
    : "assemble";
  const etaMinutes = Math.min(
    Math.max(Math.round(Number(requestBody?.eta)) || 0, 0),
    180,
  );

  let notifTitle: string;
  let notifBody: string;
  if (kind === "coming") {
    notifTitle = `🏃 ${member.display_name} is on the way`;
    notifBody = etaMinutes
      ? `Reaching CNTN in about ${etaMinutes} min ☕`
      : "Heading to CNTN ☕";
  } else if (kind === "there") {
    notifTitle = `☕ ${member.display_name} reached CNTN`;
    notifBody = "Come join the adda!";
  } else {
    notifTitle = "☕ CHAI EMERGENCY!";
    notifBody =
      `${member.display_name} is calling the gang to CNTN. Assemble now!`;

    // Only ASSEMBLE posts its own activity entry here. Status changes are
    // already logged by the app itself.
    const { error: eventError } = await admin.from("announcements").insert({
      group_id: member.group_id,
      member_id: member.id,
      kind: "assemble",
      message: `${member.display_name} says ASSEMBLE! ☕`,
    });

    if (eventError) {
      return json({
        error: `Could not post assemble event: ${eventError.message}`,
      }, 500);
    }
  }

  const payload = JSON.stringify({
    title: notifTitle,
    body: notifBody,
    url: "/",
    tag: `cntn-${kind}-${Date.now()}`,
  });

  // Existing browser subscribers.
  const { data: subscriptions, error: subError } = await admin
    .from("push_subscriptions")
    .select("id,member_id,subscription")
    .eq("group_id", member.group_id)
    .neq("member_id", member.id);

  if (subError) {
    return json({
      error: `Could not load web subscriptions: ${subError.message}`,
    }, 500);
  }

  let webSent = 0;
  let webFailed = 0;
  const expiredWeb: string[] = [];

  await Promise.all((subscriptions || []).map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, payload, {
        TTL: 3600,
      });
      webSent++;
    } catch (err) {
      webFailed++;
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        expiredWeb.push(row.id);
      }
      console.error("Web push failed:", statusCode || "", String(err));
    }
  }));

  if (expiredWeb.length) {
    await admin.from("push_subscriptions").delete().in("id", expiredWeb);
  }

  // Native Android subscribers registered through Firebase.
  const { data: devices, error: deviceError } = await admin
    .from("device_push_tokens")
    .select("id,member_id,token")
    .eq("group_id", member.group_id)
    .neq("member_id", member.id);

  if (deviceError) {
    return json({
      error: `Could not load Android devices: ${deviceError.message}`,
      webSent,
      webFailed,
    }, 500);
  }

  let androidSent = 0;
  let androidFailed = 0;
  const invalidTokens: string[] = [];

  if ((devices || []).length) {
    try {
      const accessToken = await getFirebaseAccessToken(serviceAccount);

      await Promise.all(devices.map(async (device) => {
        try {
          const response = await fetch(
            `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                message: {
                  token: device.token,
                  notification: {
                    title: notifTitle,
                    body: notifBody,
                  },
                  data: {
                    url: "/",
                    type: kind,
                  },
                  android: {
                    priority: "HIGH",
                    notification: {
                      channel_id: "cntn_alerts",
                    },
                  },
                },
              }),
            },
          );

          const result = await response.json().catch(() => ({}));

          if (response.ok) {
            androidSent++;
          } else {
            androidFailed++;
            const details = JSON.stringify(result);
            console.error("FCM delivery failed:", response.status, details);

            if (
              details.includes("UNREGISTERED") ||
              details.includes("registration-token-not-registered")
            ) {
              invalidTokens.push(device.id);
            }
          }
        } catch (err) {
          androidFailed++;
          console.error("FCM request failed:", String(err));
        }
      }));
    } catch (err) {
      androidFailed += devices.length;
      console.error("Could not obtain Firebase access token:", String(err));
    }
  }

  if (invalidTokens.length) {
    await admin.from("device_push_tokens").delete().in("id", invalidTokens);
  }

  const totalSent = webSent + androidSent;
  const totalFailed = webFailed + androidFailed;

  return json({
    ok: true,
    webSent,
    webFailed,
    androidSent,
    androidFailed,
    totalSent,
    totalFailed,
    message: totalSent
      ? `📣 Assemble sent to ${totalSent} device(s).`
      : "📣 Assemble posted, but no other registered devices received a push.",
  });
});
