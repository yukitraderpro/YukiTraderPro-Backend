const assert = require("assert");
const fs = require("fs");
process.env.DB_PATH = "/tmp/yuki_test_admin_" + Date.now() + ".sqlite";
process.env.LOG_DIR = "/tmp/yuki_test_logs";
process.env.BACKUP_DIR = "/tmp/yuki_test_backups";

const db = require("../src/db");
const buildApp = require("../src/app");
const { makeClient } = require("./testClient");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n    " + (e.stack || e.message)); } }

async function main() {
  console.log("\n== Intégration : offres publiques + administration ==\n");
  db.open();
  const app = buildApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  const call = makeClient(`http://127.0.0.1:${port}`);

  await test("GET /api/billing/offers est public (aucune authentification requise)", async () => {
    const r = await call("GET", "/api/billing/offers");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.offers.length, 2);
    assert.ok(r.json.offers.every(o => Number.isFinite(o.priceCents))); // aucun prix inventé côté client
  });

  const reg = await call("POST", "/api/auth/register", { email: "normaluser@yuki.app", password: "supersecret1" });
  const normalToken = reg.json.accessToken;
  const reg2 = await call("POST", "/api/auth/register", { email: "normaluser2@yuki.app", password: "supersecret1" });
  const regNormal2Token = reg2.json.accessToken;

  await test("un utilisateur normal ne peut pas accéder aux routes d'administration", async () => {
    const r = await call("GET", "/api/admin/offers", null, normalToken);
    assert.strictEqual(r.status, 403);
  });

  // Promeut cet utilisateur admin directement en base (simulateur d'un vrai compte admin)
  db.get().prepare("UPDATE users SET role='admin' WHERE email='normaluser@yuki.app'").run();

  await test("un utilisateur admin peut lister toutes les offres (actives et inactives)", async () => {
    const r = await call("GET", "/api/admin/offers", null, normalToken);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.offers.length, 2);
  });

  let newOfferId;
  await test("un admin peut créer une nouvelle offre/promotion sans changer le code", async () => {
    const r = await call("POST", "/api/admin/offers", { name: "Rentrée 2026", priceCents: 1500, seatLimit: 300, active: true, sortOrder: 2 }, normalToken);
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.offer.name, "Rentrée 2026");
    newOfferId = r.json.offer.id;
  });

  await test("la nouvelle offre apparaît immédiatement dans la liste publique", async () => {
    const r = await call("GET", "/api/billing/offers");
    assert.ok(r.json.offers.some(o => o.id === newOfferId));
  });

  await test("un admin peut modifier le prix d'une offre existante", async () => {
    const r = await call("PUT", `/api/admin/offers/${newOfferId}`, { priceCents: 1200 }, normalToken);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.offer.priceCents, 1200);
  });

  await test("un admin peut désactiver une offre, qui disparaît alors de la liste publique", async () => {
    await call("PUT", `/api/admin/offers/${newOfferId}`, { active: false }, normalToken);
    const r = await call("GET", "/api/billing/offers");
    assert.ok(!r.json.offers.some(o => o.id === newOfferId));
  });

  await test("un admin peut suivre le nombre d'abonnés par offre", async () => {
    const r = await call("GET", "/api/admin/subscribers", null, normalToken);
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.offers));
    assert.ok(typeof r.json.totalActiveSubscribers === "number");
  });

  await test("l'historique des modifications de prix est accessible et trace la création puis la modification (addendum V3.3)", async () => {
    const list = await call("GET", "/api/admin/offers", null, normalToken);
    const offer = list.json.offers.find(o => o.id === newOfferId);
    const before = await call("GET", `/api/admin/offers/${offer.id}/price-history`, null, normalToken);
    assert.strictEqual(before.status, 200);
    assert.strictEqual(before.json.history.length, 2); // création (1500) + modification (1200)
    assert.strictEqual(before.json.history[0].new_price_cents, 1200);
    assert.strictEqual(before.json.history[0].old_price_cents, 1500);
  });

  await test("un utilisateur non-admin ne peut pas consulter l'historique des prix", async () => {
    const list = await call("GET", "/api/admin/offers", null, normalToken);
    const offer = list.json.offers[0];
    const r = await call("GET", `/api/admin/offers/${offer.id}/price-history`, null, regNormal2Token);
    assert.strictEqual(r.status, 403);
  });

  await test("un utilisateur sans offre active reçoit `offer: null` sur /billing/my-offer", async () => {
    const r = await call("GET", "/api/billing/my-offer", null, normalToken);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.offer, null);
  });

  /* ================= Gestion des rôles/comptes par un admin (V4 — Partie 1.3) =================
     Le rôle ne doit plus jamais être décidé par le navigateur : ces routes
     remplacent l'ancienne mutation locale (`setUserRole`/`deleteUser` dans
     auth.js), supprimée du client. */
  await test("un non-admin ne peut pas lister les utilisateurs", async () => {
    const r = await call("GET", "/api/admin/users", null, regNormal2Token);
    assert.strictEqual(r.status, 403);
  });

  await test("un admin peut lister les utilisateurs", async () => {
    const r = await call("GET", "/api/admin/users", null, normalToken);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.users.some(u => u.email === "normaluser2@yuki.app"));
  });

  await test("un non-admin ne peut pas changer le rôle d'un autre utilisateur", async () => {
    const r = await call("PUT", `/api/admin/users/${reg2.json.user.id}/role`, { role: "pro" }, regNormal2Token);
    assert.strictEqual(r.status, 403);
  });

  await test("un rôle invalide est rejeté", async () => {
    const r = await call("PUT", `/api/admin/users/${reg2.json.user.id}/role`, { role: "superadmin" }, normalToken);
    assert.strictEqual(r.status, 400);
  });

  await test("un admin peut promouvoir un utilisateur en pro (et `subscribed` passe à true)", async () => {
    const r = await call("PUT", `/api/admin/users/${reg2.json.user.id}/role`, { role: "pro" }, normalToken);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.user.role, "pro");
    assert.strictEqual(!!r.json.user.subscribed, true);
  });

  await test("le changement de rôle est bien journalisé dans audit_log", async () => {
    const row = db.get().prepare("SELECT * FROM audit_log WHERE action = 'admin.user.role_changed' ORDER BY created_at DESC LIMIT 1").get();
    assert.ok(row);
    const meta = JSON.parse(row.meta);
    assert.strictEqual(meta.to, "pro");
  });

  await test("un admin ne peut pas retirer son propre rôle admin depuis cet écran", async () => {
    const me = await call("GET", "/api/auth/me", null, normalToken);
    const r = await call("PUT", `/api/admin/users/${me.json.user.id}/role`, { role: "free" }, normalToken);
    assert.strictEqual(r.status, 400);
  });

  await test("un admin ne peut pas supprimer son propre compte depuis cet écran", async () => {
    const me = await call("GET", "/api/auth/me", null, normalToken);
    const r = await call("DELETE", `/api/admin/users/${me.json.user.id}`, null, normalToken);
    assert.strictEqual(r.status, 400);
  });

  await test("un admin peut supprimer un autre compte, qui disparaît de la liste", async () => {
    const r = await call("DELETE", `/api/admin/users/${reg2.json.user.id}`, null, normalToken);
    assert.strictEqual(r.status, 200);
    const list = await call("GET", "/api/admin/users", null, normalToken);
    assert.ok(!list.json.users.some(u => u.id === reg2.json.user.id));
  });

  await test("le compte supprimé ne peut plus se connecter", async () => {
    const r = await call("POST", "/api/auth/login", { email: "normaluser2@yuki.app", password: "supersecret1" });
    assert.strictEqual(r.status, 401);
  });

  server.close();
  db.close();
  try { fs.unlinkSync(process.env.DB_PATH); } catch {}
  try { fs.unlinkSync(process.env.DB_PATH + "-wal"); } catch {}
  try { fs.unlinkSync(process.env.DB_PATH + "-shm"); } catch {}

  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
  process.exit(failed ? 1 : 0);
}
main();
