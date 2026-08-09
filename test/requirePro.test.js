/* ==========================================================================
   Verrou serveur d'accès Pro (V4.11)
   --------------------------------------------------------------------------
   Ces tests portent sur la seule chose que le client ne peut pas contourner :
   la décision prise en base par getAccessState(). Ils vérifient aussi que le
   verrou ne va PAS trop loin — un compte expiré doit conserver l'accès à ses
   propres données et pouvoir les supprimer (RGPD).
   ========================================================================== */
process.env.NODE_ENV = "test";

const assert = require("node:assert");
const crypto = require("node:crypto");
const db = require("../src/db");
const { hashPassword } = require("../src/crypto/password");

db.open(":memory:");
const conn = db.get();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  \u2713 " + name); }
  catch (e) { failed++; console.log("  \u2717 " + name + "\n    " + (e.stack || e.message)); }
}
function summary() {
  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
  if (failed > 0) process.exit(1);
}

const { getAccessState } = require("../src/middleware/requirePro");
const requirePro = require("../src/middleware/requirePro");

const DAY = 86400000;

function makeUser({ role = "free", subscribed = 0, trialOffsetDays = 7 }) {
  const id = crypto.randomUUID();
  conn.prepare(`
    INSERT INTO users (id, email, password_hash, role, created_at, trial_until, subscribed)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, id + "@exemple.local", hashPassword("motdepasse"), role,
         Date.now(), Date.now() + trialOffsetDays * DAY, subscribed);
  return id;
}

/* Exécute le middleware et rapporte s'il a laissé passer. */
async function runMiddleware(userId) {
  const ctx = { userId };
  let passedThrough = false;
  try {
    await requirePro(ctx, async () => { passedThrough = true; });
    return { passedThrough, status: null };
  } catch (e) {
    return { passedThrough, status: e.status || e.statusCode || null, message: e.message };
  }
}

console.log("\n== Verrou serveur d'accès Pro ==\n");

test("un essai en cours donne accès", () => {
  const state = getAccessState(makeUser({ trialOffsetDays: 3 }));
  assert.strictEqual(state.allowed, true);
  assert.strictEqual(state.reason, "trial");
});

test("les jours restants sont arrondis au jour supérieur", () => {
  /* Essai finissant dans 2 h : l'utilisateur doit lire "1 jour", pas "0". */
  const id = makeUser({});
  conn.prepare("UPDATE users SET trial_until = ? WHERE id = ?").run(Date.now() + 2 * 3600000, id);
  assert.strictEqual(getAccessState(id).trialDaysLeft, 1);
});

test("un essai expiré coupe l'accès", () => {
  const state = getAccessState(makeUser({ trialOffsetDays: -1 }));
  assert.strictEqual(state.allowed, false);
  assert.strictEqual(state.reason, "trial_expired");
});

test("un abonnement actif donne accès même après expiration de l'essai", () => {
  const state = getAccessState(makeUser({ subscribed: 1, trialOffsetDays: -30 }));
  assert.strictEqual(state.allowed, true);
  assert.strictEqual(state.reason, "subscribed");
});

test("un administrateur garde l'accès sans essai ni abonnement", () => {
  const state = getAccessState(makeUser({ role: "admin", trialOffsetDays: -100 }));
  assert.strictEqual(state.allowed, true);
  assert.strictEqual(state.reason, "admin");
});

test("le rôle 'pro' porté par le client ne suffit PAS sans abonnement en base", () => {
  /* Cœur du dispositif : quelqu'un qui se donne role="pro" dans le
     navigateur n'a rien changé en base, donc le serveur refuse. */
  const state = getAccessState(makeUser({ role: "pro", subscribed: 0, trialOffsetDays: -1 }));
  assert.strictEqual(state.allowed, false, "un rôle 'pro' sans abonnement ne doit pas ouvrir l'accès");
});

test("un utilisateur inexistant est refusé", () => {
  const state = getAccessState("identifiant-qui-n-existe-pas");
  assert.strictEqual(state.allowed, false);
  assert.strictEqual(state.reason, "unknown_user");
});

console.log("\n== Middleware requirePro ==\n");

test("le middleware laisse passer un essai valide", async () => {
  const r = await runMiddleware(makeUser({ trialOffsetDays: 5 }));
  assert.strictEqual(r.passedThrough, true);
});

test("le middleware bloque un essai expiré avec un code 402", async () => {
  const r = await runMiddleware(makeUser({ trialOffsetDays: -1 }));
  assert.strictEqual(r.passedThrough, false);
  assert.strictEqual(r.status, 402, "402 permet au client d'afficher l'écran d'abonnement");
});

console.log("\n== Périmètre du verrou (ce qui doit rester ouvert) ==\n");

test("les routes de lecture et de suppression ne sont pas protégées", () => {
  const fs = require("fs");
  const sync = fs.readFileSync(__dirname + "/../src/routes/sync.js", "utf8");
  const csv = fs.readFileSync(__dirname + "/../src/routes/csvImport.js", "utf8");
  const notif = fs.readFileSync(__dirname + "/../src/routes/notifications.js", "utf8");

  /* RGPD : récupérer ses données et les effacer doit rester possible après
     expiration. Si l'un de ces asserts casse, c'est que le verrou a été
     étendu trop loin. */
  assert.ok(/router\.get\("\/state", authenticate, async/.test(sync),
    "GET /state doit rester accessible (droit d'accès à ses données)");
  assert.ok(/router\.delete\("\/devices\/:id", authenticate, async/.test(sync),
    "supprimer un appareil doit rester possible");
  assert.ok(/router\.delete\("\/imports\/:id", authenticate, wrap/.test(csv),
    "supprimer un import doit rester possible");
  assert.ok(/router\.post\("\/imports\/:id\/cancel", authenticate, wrap/.test(csv),
    "annuler un import doit rester possible");
  assert.ok(/router\.delete\("\/token\/:token", authenticate, async/.test(notif),
    "retirer un token de notification doit rester possible");
});

test("les routes d'usage sont bien protégées", () => {
  const fs = require("fs");
  const sync = fs.readFileSync(__dirname + "/../src/routes/sync.js", "utf8");
  const csv = fs.readFileSync(__dirname + "/../src/routes/csvImport.js", "utf8");
  const notif = fs.readFileSync(__dirname + "/../src/routes/notifications.js", "utf8");

  assert.ok(/router\.put\("\/state", authenticate, requirePro/.test(sync));
  assert.ok(/router\.post\("\/imports", authenticate, requirePro/.test(csv));
  assert.ok(/router\.post\("\/imports\/:id\/confirm", authenticate, requirePro/.test(csv));
  assert.ok(/router\.post\("\/register-token", authenticate, requirePro/.test(notif));
});

setTimeout(summary, 50);
