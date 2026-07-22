const assert = require("assert");
const crypto = require("crypto");

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n    " + e.message); } }
async function atest(name, fn) { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n    " + e.message); } }

console.log("\n== Notifications push (FCM, logique métier) ==\n");

async function main() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  process.env.FIREBASE_PROJECT_ID = "yuki-trader-pro";
  process.env.FIREBASE_SERVICE_ACCOUNT_EMAIL = "fcm-svc@yuki-trader-pro.iam.gserviceaccount.com";
  process.env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY = privateKey;
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/services/fcmService")];
  const fcmService = require("../src/services/fcmService");

  await atest("sendPush envoie un message bien formé et traite une réponse 200 comme un succès", async () => {
    let capturedBody = null;
    const fakeHttpClient = async ({ url, body }) => {
      if (url.includes("oauth2.googleapis.com")) return { status: 200, json: { access_token: "fake-fcm-token" } };
      if (url.includes("fcm.googleapis.com")) { capturedBody = JSON.parse(body); return { status: 200, json: { name: "projects/x/messages/1" } }; }
      return { status: 500, json: null };
    };
    const result = await fcmService.sendPush("device-token-abc", { title: "Yuki · ACHETER NVDA", body: "Confiance 91% · A+", data: { instrumentId: "NVDA", url: "/" } }, fakeHttpClient);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(capturedBody.message.token, "device-token-abc");
    assert.strictEqual(capturedBody.message.notification.title, "Yuki · ACHETER NVDA");
    assert.strictEqual(capturedBody.message.data.instrumentId, "NVDA");
  });

  await atest("sendPush renvoie ok=false si FCM répond une erreur", async () => {
    const fakeHttpClient = async ({ url }) => {
      if (url.includes("oauth2.googleapis.com")) return { status: 200, json: { access_token: "fake" } };
      return { status: 404, json: { error: { message: "Requested entity was not found." } } };
    };
    const result = await fcmService.sendPush("token-invalide", { title: "x", body: "y" }, fakeHttpClient);
    assert.strictEqual(result.ok, false);
  });

  await atest("sendPush échoue proprement si le compte de service Firebase n'est pas configuré", async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_EMAIL;
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/services/fcmService")];
    const fcmServiceUnconfigured = require("../src/services/fcmService");
    await assert.rejects(() => fcmServiceUnconfigured.sendPush("t", { title: "a", body: "b" }, async () => ({ status: 200, json: {} })));
  });

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
  process.exit(failed ? 1 : 0);
}
main();
