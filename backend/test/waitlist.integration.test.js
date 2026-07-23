/* ==========================================================================
   Tests d'intégration — /api/waitlist (liste d'attente pré-lancement)
   Exécution : node test/waitlist.integration.test.js
   ========================================================================== */
const assert = require("assert");
process.env.DB_PATH = "/tmp/yuki_test_waitlist_" + Date.now() + ".sqlite";
process.env.LOG_DIR = "/tmp/yuki_test_logs";
process.env.BACKUP_DIR = "/tmp/yuki_test_backups";

const db = require("../src/db");
const buildApp = require("../src/app");
const { makeClient } = require("./testClient");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + (e.stack || e.message)); }
}

async function main() {
  console.log("\n== Intégration : liste d'attente (/api/waitlist) ==\n");
  db.open();
  const app = buildApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  const call = makeClient(`http://127.0.0.1:${port}`);

  await test("une inscription valide est acceptée", async () => {
    const r = await call("POST", "/api/waitlist", { email: "Fan.Un@Example.com", source: "landing" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
  });

  await test("l'e-mail est normalisé (minuscules) et stocké une seule fois", async () => {
    const r = await call("POST", "/api/waitlist", { email: "fan.un@example.com" });
    assert.strictEqual(r.status, 200, "réinscription idempotente : 200, pas d'erreur");
    const row = db.get().prepare("SELECT COUNT(*) AS n FROM waitlist WHERE email = ?").get("fan.un@example.com");
    assert.strictEqual(row.n, 1);
  });

  await test("la réinscription ne révèle pas qu'une adresse existe déjà (réponse identique)", async () => {
    const first = await call("POST", "/api/waitlist", { email: "fan.deux@example.com" });
    const again = await call("POST", "/api/waitlist", { email: "fan.deux@example.com" });
    assert.strictEqual(first.status, again.status);
    assert.deepStrictEqual(first.json, again.json);
  });

  await test("une adresse invalide est rejetée (400)", async () => {
    for (const bad of ["pasunemail", "a@b", "", null]) {
      const r = await call("POST", "/api/waitlist", { email: bad });
      assert.strictEqual(r.status, 400, `attendu 400 pour ${JSON.stringify(bad)}`);
    }
  });

  await test("le compteur public reflète les inscriptions", async () => {
    const r = await call("GET", "/api/waitlist/count");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.count, 2);
  });

  await test("l'export est refusé sans authentification", async () => {
    const r = await call("GET", "/api/waitlist/export");
    assert.strictEqual(r.status, 401);
  });

  await test("l'export est refusé pour un utilisateur non-admin", async () => {
    const reg = await call("POST", "/api/auth/register", { email: "user@yuki.app", password: "supersecret1" });
    const r = await call("GET", "/api/waitlist/export", null, reg.json.accessToken);
    assert.strictEqual(r.status, 403);
  });

  await test("l'export renvoie la liste complète pour un admin", async () => {
    const reg = await call("POST", "/api/auth/register", { email: "admin@yuki.app", password: "supersecret1" });
    db.get().prepare("UPDATE users SET role = 'admin' WHERE email = ?").run("admin@yuki.app");
    // nouveau login pour un token à jour (le rôle est de toute façon revérifié en base)
    const login = await call("POST", "/api/auth/login", { email: "admin@yuki.app", password: "supersecret1" });
    const r = await call("GET", "/api/waitlist/export", null, login.json.accessToken);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.count, 2);
    assert.ok(r.json.entries.every(e => e.email && e.created_at));
  });

  await test("l'anti-abus bloque au-delà de 5 inscriptions dans la fenêtre (429)", async () => {
    let blocked = false;
    for (let i = 0; i < 8; i++) {
      const r = await call("POST", "/api/waitlist", { email: `flood${i}@example.com` });
      if (r.status === 429) { blocked = true; break; }
    }
    assert.ok(blocked, "aucune requête bloquée après 8 tentatives");
  });

  server.close();
  db.close();
  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
  process.exit(failed ? 1 : 0);
}
main();
