/* BACKEND_17 — routes /api/feedback : authentification requise, réponse enregistrée,
   résumé réservé à l'administrateur. */
const assert = require("assert");
process.env.DB_PATH = "/tmp/yuki_test_feedback_" + Date.now() + ".sqlite";
process.env.LOG_DIR = "/tmp/yuki_test_logs";
process.env.BACKUP_DIR = "/tmp/yuki_test_backups";

const db = require("../src/db");
const buildApp = require("../src/app");
const { makeClient } = require("./testClient");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n    " + (e.stack || e.message)); } }

async function main() {
  console.log("\n== Intégration : retours (BACKEND_17) ==\n");
  db.open();
  const app = buildApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  const call = makeClient(`http://127.0.0.1:${port}`);

  const reg = await call("POST", "/api/auth/register", { email: "essai@yuki.app", password: "supersecret1" });
  const token = reg.json.accessToken;
  const adm = await call("POST", "/api/auth/register", { email: "admin@yuki.app", password: "supersecret1" });
  const admToken = adm.json.accessToken;
  db.get().prepare("UPDATE users SET role='admin' WHERE email='admin@yuki.app'").run();

  await test("sans jeton : 401 sur les trois routes", async () => {
    assert.strictEqual((await call("GET", "/api/feedback/eligibility")).status, 401);
    assert.strictEqual((await call("POST", "/api/feedback", { rating: 5 })).status, 401);
    assert.strictEqual((await call("GET", "/api/feedback/summary")).status, 401);
  });

  await test("compte tout neuf : pas encore interrogé", async () => {
    const r = await call("GET", "/api/feedback/eligibility", null, token);
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json, { ask: false, reason: "not_eligible" });
  });

  db.get().prepare("UPDATE users SET created_at = created_at - 10 * 86400000 WHERE email='essai@yuki.app'").run();

  await test("compte de 10 jours non abonné : questionnaire d'essai ; réponse vide refusée (400) ; réponse enregistrée (200) ; plus posée ensuite", async () => {
    assert.deepStrictEqual((await call("GET", "/api/feedback/eligibility", null, token)).json, { ask: true, kind: "trial" });
    const bad = await call("POST", "/api/feedback", { reasons: [] }, token);
    assert.strictEqual(bad.status, 400);
    const ok = await call("POST", "/api/feedback", { reasons: ["price", "unclear"], rating: 4, comment: "Pas mal" }, token);
    assert.strictEqual(ok.status, 200); assert.deepStrictEqual(ok.json, { ok: true, recorded: true, status: "answered", kind: "trial" });
    assert.deepStrictEqual((await call("GET", "/api/feedback/eligibility", null, token)).json, { ask: false, reason: "answered", kind: "trial" });
  });

  await test("résumé : 403 pour un utilisateur, 200 pour l'administrateur avec l'e-mail et les raisons", async () => {
    assert.strictEqual((await call("GET", "/api/feedback/summary", null, token)).status, 403);
    const r = await call("GET", "/api/feedback/summary", null, admToken);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.trial.answered, 1); assert.strictEqual(r.json.trial.counts.price, 1);
    assert.strictEqual(r.json.trial.list[0].email, "essai@yuki.app"); assert.strictEqual(r.json.trial.avgRating, 4);
    assert.strictEqual(r.json.subscriber.answered, 0);
  });

  server.close();
  console.log(`\n${passed} réussi(s), ${failed} échoué(s)\n`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
