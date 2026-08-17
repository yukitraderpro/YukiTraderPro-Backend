/* ==========================================================================
   Tests V4.13.3 — acquittement des achats Google Play
   --------------------------------------------------------------------------
   Constaté en test réel le 17/08/2026 : après un achat, Play affichait
   « Confirmez le forfait — Ouvrez cette appli pour confirmer votre forfait
   avant… ». Cause : aucun appel :acknowledge n'existait dans le projet.
   Conséquence en production : Google REMBOURSE et RÉVOQUE automatiquement
   tout abonnement non acquitté sous 3 jours. Ces tests verrouillent le
   correctif avec un client HTTP simulé (aucun appel réseau réel).
   ========================================================================== */
const assert = require("assert");
const path = require("path");
const crypto = require("crypto");

/* Même mise en place que billing.unit.test.js : on renseigne les variables
   d'environnement AVANT de charger config et le service, avec une clé RSA
   générée localement pour l'occasion (jamais de vraie clé dans les tests). */
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});
process.env.GOOGLE_PLAY_PACKAGE_NAME = "com.yuki.trader";
process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL = "svc@yuki.iam.gserviceaccount.com";
process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY = privateKey;
delete require.cache[require.resolve("../src/config")];
delete require.cache[require.resolve("../src/services/googlePlayService")];
const svc = require(path.join(__dirname, "..", "src", "services", "googlePlayService.js"));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + e.message); }
}

/* Client HTTP simulé : répond au jeton OAuth, puis renvoie le statut voulu. */
function fakeClient(ackStatus, calls) {
  return async ({ method, url, body, headers }) => {
    calls.push({ method, url, body, headers });
    if (url.includes("oauth2.googleapis.com")) return { status: 200, json: { access_token: "jeton-test" } };
    return { status: ackStatus, json: {} };
  };
}

(async () => {
  console.log("\n== V4.13.3 — acquittement Google Play ==\n");

  await test("la fonction d'acquittement est exportée par le service", () => {
    assert.strictEqual(typeof svc.acknowledgeSubscription, "function");
  });

  await test("elle appelle bien l'endpoint :acknowledge en POST, avec le jeton d'accès", async () => {
    const calls = [];
    await svc.acknowledgeSubscription("jeton-achat", "yuki_pro_founder_monthly", fakeClient(200, calls));
    const ack = calls.find(c => c.url.includes(":acknowledge"));
    assert.ok(ack, "aucun appel à :acknowledge");
    assert.strictEqual(ack.method, "POST");
    assert.ok(ack.url.includes("yuki_pro_founder_monthly"), "identifiant de produit absent de l'URL");
    assert.ok(ack.url.includes("jeton-achat"), "jeton d'achat absent de l'URL");
    assert.ok(String(ack.headers.Authorization).startsWith("Bearer "), "en-tête d'autorisation absent");
  });

  await test("un 204 (sans contenu) est traité comme un succès", async () => {
    const r = await svc.acknowledgeSubscription("t", "p", fakeClient(204, []));
    assert.strictEqual(r.acknowledged, true);
    assert.strictEqual(r.alreadyAcknowledged, false);
  });

  await test("un achat DÉJÀ acquitté (400/409) est un succès, pas une erreur", async () => {
    for (const code of [400, 409]) {
      const r = await svc.acknowledgeSubscription("t", "p", fakeClient(code, []));
      assert.strictEqual(r.acknowledged, true, "code " + code + " mal interprété");
      assert.strictEqual(r.alreadyAcknowledged, true);
    }
  });

  await test("un vrai échec (500) est signalé, jamais masqué en succès", async () => {
    const r = await svc.acknowledgeSubscription("t", "p", fakeClient(500, []));
    assert.strictEqual(r.acknowledged, false);
    assert.strictEqual(r.status, 500);
  });

  await test("la route verify-purchase acquitte avant d'accorder l'accès", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "src", "routes", "billing.js"), "utf8");
    const iAck = src.indexOf("acknowledgeSubscription");
    const iGrant = src.indexOf("UPDATE users SET subscribed");
    assert.ok(iAck > -1, "acquittement absent de la route");
    assert.ok(iGrant > -1 && iAck < iGrant, "l'acquittement doit précéder l'octroi de l'accès");
  });

  await test("un échec d'acquittement ne prive PAS l'utilisateur de son accès", () => {
    const src = require("fs").readFileSync(path.join(__dirname, "..", "src", "routes", "billing.js"), "utf8");
    const bloc = src.slice(src.indexOf("acknowledgeSubscription") - 400, src.indexOf("const conn = db.get()"));
    assert.ok(bloc.includes("try") && bloc.includes("catch"), "l'appel n'est pas protégé par try/catch");
    assert.ok(!/throw new HttpError[^]{0,120}acknowledge/i.test(bloc), "un échec d'acquittement ne doit pas interrompre la requête");
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
  if (failed > 0) process.exit(1);
})();
