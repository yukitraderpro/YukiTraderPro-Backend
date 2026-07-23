/* ==========================================================================
   Vérification serveur des achats Google Play Billing
   --------------------------------------------------------------------------
   Implémente le flux standard de la Play Developer API (androidpublisher) :
     1) s'authentifier en tant que compte de service Google Cloud via un
        JWT bearer grant (RFC 7523) signé RS256 ;
     2) échanger ce JWT contre un access token OAuth2 auprès de Google ;
     3) appeler `purchases.subscriptions.get` (ou `purchases.products.get`
        pour un achat unique) avec ce token pour connaître le statut réel
        de l'abonnement, directement depuis les serveurs Google — c'est ce
        qui rend l'abonnement « non contournable » côté client (critère
        d'acceptation du cahier des charges), puisqu'un `purchaseToken`
        falsifié côté app ne passera jamais cette vérification serveur.

   Ce module ne peut pas être testé de bout en bout dans l'environnement de
   développement utilisé ici (accès réseau sortant désactivé — voir
   Difficultes_YukiTraderPro_V3.md). Le client HTTP est donc injectable
   (`httpClient`) : les tests unitaires (test/billing.unit.test.js) simulent
   les réponses de Google pour vérifier la logique métier (statuts
   actif/expiré/remboursé), et un vrai déploiement n'a qu'à laisser le
   client HTTP par défaut (basé sur `https`, aucune dépendance npm).
   ========================================================================== */
const crypto = require("crypto");
const https = require("https");
const config = require("../config");
const logger = require("../logger");

function defaultHttpClient({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      res => {
        let data = "";
        res.on("data", c => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function base64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

/* Construit et signe un JWT RS256 "assertion" pour le flux OAuth2 de compte
   de service Google (RFC 7523), puis l'échange contre un access token. */
async function getAccessToken(httpClient) {
  const { serviceAccountEmail, serviceAccountPrivateKey } = config.googlePlay;
  if (!serviceAccountEmail || !serviceAccountPrivateKey) {
    throw new Error("Compte de service Google Play non configuré (GOOGLE_PLAY_SERVICE_ACCOUNT_*).");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64url(Buffer.from(JSON.stringify({
    iss: serviceAccountEmail,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })));
  const signature = base64url(crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), serviceAccountPrivateKey));
  const assertion = `${header}.${claims}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  }).toString();

  const res = await httpClient({
    method: "POST",
    url: "https://oauth2.googleapis.com/token",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    body
  });
  if (res.status !== 200 || !res.json || !res.json.access_token) {
    throw new Error("Échec de l'authentification du compte de service Google.");
  }
  return res.json.access_token;
}

/* Vérifie un abonnement Google Play via purchases.subscriptions.get. */
async function verifySubscription(purchaseToken, subscriptionId, httpClient = defaultHttpClient) {
  const { packageName } = config.googlePlay;
  if (!packageName) throw new Error("GOOGLE_PLAY_PACKAGE_NAME non configuré.");
  const accessToken = await getAccessToken(httpClient);
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(subscriptionId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await httpClient({ method: "GET", url, headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status !== 200 || !res.json) {
    logger.warn("Vérification Google Play échouée", { status: res.status });
    return { status: "invalid", raw: res.json };
  }
  return interpretSubscriptionResponse(res.json);
}

/* Traduit la réponse brute de Google en un statut applicatif simple.
   Référence : champ `paymentState` (0=en attente, 1=payé, 2=essai gratuit,
   3=en attente de report) et `expiryTimeMillis`. */
function interpretSubscriptionResponse(raw) {
  const expiryAt = raw.expiryTimeMillis ? parseInt(raw.expiryTimeMillis, 10) : null;
  const now = Date.now();
  let status = "active";
  if (raw.cancelReason !== undefined && raw.cancelReason !== null && expiryAt && expiryAt < now) status = "cancelled";
  else if (expiryAt && expiryAt < now) status = "expired";
  else if (raw.paymentState === 0) status = "pending";
  return { status, expiryAt, autoRenewing: !!raw.autoRenewing, raw };
}

module.exports = { verifySubscription, getAccessToken, interpretSubscriptionResponse, defaultHttpClient };
