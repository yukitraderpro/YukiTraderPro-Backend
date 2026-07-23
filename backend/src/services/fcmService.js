/* ==========================================================================
   Firebase Cloud Messaging — envoi de notifications push, y compris
   application fermée (critère d'acceptation du cahier des charges V3).
   --------------------------------------------------------------------------
   Utilise directement l'API HTTP v1 de FCM (`fcm.googleapis.com/v1/...`)
   plutôt que le SDK `firebase-admin`, indisponible sans accès npm dans cet
   environnement. Même mécanisme d'authentification par compte de service
   que googlePlayService.js (JWT RS256 → access token OAuth2), donc même
   limite documentée : non testable de bout en bout hors-ligne, mais
   couvert par des tests unitaires avec client HTTP injecté.
   ========================================================================== */
const crypto = require("crypto");
const https = require("https");
const config = require("../config");
const logger = require("../logger");

function defaultHttpClient({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function base64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

async function getAccessToken(httpClient) {
  const { serviceAccountEmail, serviceAccountPrivateKey } = config.firebase;
  if (!serviceAccountEmail || !serviceAccountPrivateKey) {
    throw new Error("Compte de service Firebase non configuré (FIREBASE_SERVICE_ACCOUNT_*).");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64url(Buffer.from(JSON.stringify({
    iss: serviceAccountEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })));
  const signature = base64url(crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), serviceAccountPrivateKey));
  const assertion = `${header}.${claims}.${signature}`;
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString();
  const res = await httpClient({
    method: "POST", url: "https://oauth2.googleapis.com/token",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    body
  });
  if (res.status !== 200 || !res.json || !res.json.access_token) throw new Error("Échec de l'authentification du compte de service Firebase.");
  return res.json.access_token;
}

/* Envoie une notification push à un token FCM donné.
   `data` doit rester un dictionnaire de chaînes de caractères (contrainte FCM). */
async function sendPush(fcmToken, { title, body, data = {} }, httpClient = defaultHttpClient) {
  const { projectId } = config.firebase;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID non configuré.");
  const accessToken = await getAccessToken(httpClient);
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
  const message = {
    message: {
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      webpush: { fcm_options: { link: data.url || "/" } }
    }
  };
  const payload = JSON.stringify(message);
  const res = await httpClient({
    method: "POST", url,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    body: payload
  });
  if (res.status < 200 || res.status >= 300) {
    logger.warn("Échec envoi FCM", { status: res.status, response: res.json });
    return { ok: false, response: res.json };
  }
  return { ok: true, response: res.json };
}

module.exports = { sendPush, getAccessToken, defaultHttpClient };
