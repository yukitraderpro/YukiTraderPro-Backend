/* ==========================================================================
   JWT (JSON Web Token) — implémentation minimale HS256, sans dépendance.
   --------------------------------------------------------------------------
   Pourquoi une implémentation maison plutôt que `jsonwebtoken` : accès npm
   indisponible dans cet environnement (voir README_BACKEND.md). Le format
   produit est un JWT HS256 standard (header.payload.signature, Base64URL),
   vérifiable par n'importe quelle librairie JWT tierce — donc remplaçable
   par `jsonwebtoken` en une ligne dès qu'un vrai déploiement avec accès npm
   est possible, sans changer le format des tokens déjà émis.
   ========================================================================== */
const crypto = require("crypto");

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlToBuffer(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

function sign(payload, secret, { expiresInSeconds } = {}) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { iat: now, ...(expiresInSeconds ? { exp: now + expiresInSeconds } : {}), ...payload };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(fullPayload));
  const signature = crypto.createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest();
  const encodedSignature = base64url(signature);
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

class JwtError extends Error {}

function verify(token, secret) {
  if (typeof token !== "string" || token.split(".").length !== 3) throw new JwtError("Format de token invalide.");
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const expectedSig = crypto.createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest();
  const actualSig = base64urlToBuffer(encodedSignature);
  if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
    throw new JwtError("Signature invalide.");
  }
  let payload;
  try { payload = JSON.parse(base64urlToBuffer(encodedPayload).toString("utf8")); }
  catch { throw new JwtError("Payload illisible."); }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) throw new JwtError("Token expiré.");
  return payload;
}

module.exports = { sign, verify, JwtError };
