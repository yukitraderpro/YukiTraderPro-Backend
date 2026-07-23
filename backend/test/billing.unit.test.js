const assert = require("assert");
const googlePlayService = require("../src/services/googlePlayService");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + e.message); }
}

console.log("\n== Vérification Google Play Billing (logique métier) ==\n");

test("interpretSubscriptionResponse : abonnement actif, non expiré", () => {
  const r = googlePlayService.interpretSubscriptionResponse({
    expiryTimeMillis: String(Date.now() + 30 * 24 * 3600000), paymentState: 1, autoRenewing: true
  });
  assert.strictEqual(r.status, "active");
  assert.strictEqual(r.autoRenewing, true);
});

test("interpretSubscriptionResponse : abonnement expiré", () => {
  const r = googlePlayService.interpretSubscriptionResponse({
    expiryTimeMillis: String(Date.now() - 3600000), paymentState: 1, autoRenewing: false
  });
  assert.strictEqual(r.status, "expired");
});

test("interpretSubscriptionResponse : paiement en attente", () => {
  const r = googlePlayService.interpretSubscriptionResponse({
    expiryTimeMillis: String(Date.now() + 3600000), paymentState: 0
  });
  assert.strictEqual(r.status, "pending");
});

test("interpretSubscriptionResponse : annulé et expiré", () => {
  const r = googlePlayService.interpretSubscriptionResponse({
    expiryTimeMillis: String(Date.now() - 3600000), cancelReason: 1
  });
  assert.strictEqual(r.status, "cancelled");
});

async function asyncTests() {
  await (async () => {
    try {
      // Simule les réponses Google (token OAuth2 puis statut d'abonnement) avec un
      // client HTTP injecté — aucune requête réseau réelle n'est faite ici.
      process.env.GOOGLE_PLAY_PACKAGE_NAME = "com.yuki.trader";
      process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL = "svc@yuki.iam.gserviceaccount.com";
      process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY = TEST_PRIVATE_KEY;
      delete require.cache[require.resolve("../src/config")];
      delete require.cache[require.resolve("../src/services/googlePlayService")];
      const svc = require("../src/services/googlePlayService");

      const fakeHttpClient = async ({ url }) => {
        if (url.includes("oauth2.googleapis.com")) return { status: 200, json: { access_token: "fake-token" } };
        if (url.includes("androidpublisher.googleapis.com")) {
          return { status: 200, json: { expiryTimeMillis: String(Date.now() + 86400000), paymentState: 1, autoRenewing: true } };
        }
        return { status: 500, json: null };
      };
      const result = await svc.verifySubscription("purchase-token-abc", "yuki_pro_monthly", fakeHttpClient);
      assert.strictEqual(result.status, "active");
      passed++; console.log("  ✓ verifySubscription (bout en bout, client HTTP simulé) renvoie 'active'");
    } catch (e) {
      failed++; console.log("  ✗ verifySubscription bout en bout\n    " + e.message);
    }
  })();

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
  process.exit(failed ? 1 : 0);
}

// Clé RSA de test générée localement (usage tests uniquement, ne jamais utiliser en production).
const crypto = require("crypto");
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const TEST_PRIVATE_KEY = privateKey;

asyncTests();
