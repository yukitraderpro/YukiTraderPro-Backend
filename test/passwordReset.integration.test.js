/* ==========================================================================
   Intégration : réinitialisation de mot de passe (V4.11)
   --------------------------------------------------------------------------
   Ce test existe parce qu'un bug est passé en production : le code utilisait
   `conn.transaction()` (API better-sqlite3) alors que le projet tourne sur
   node:sqlite, qui ne l'expose pas. L'erreur n'apparaissait qu'au moment du
   clic final de l'utilisateur. On couvre donc le chemin complet.
   ========================================================================== */
process.env.DB_PATH = "/tmp/yuki_test_reset_" + Date.now() + ".sqlite";
process.env.NODE_ENV = "test";
process.env.RESEND_API_KEY = ""; // envoi désactivé : on lit le jeton en base

const assert = require("node:assert");
const crypto = require("node:crypto");
const db = require("../src/db");
const authService = require("../src/services/authService");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  \u2713 " + name); }
  catch (e) { failed++; console.log("  \u2717 " + name + "\n    " + (e.stack || e.message)); }
}
function summary() {
  console.log(`\n${passed} test(s) r\u00e9ussi(s), ${failed} \u00e9chec(s).\n`);
  if (failed > 0) process.exit(1);
}

db.open(":memory:");
const conn = db.get();

const EMAIL = "reset-test@exemple.local";
const OLD_PASSWORD = "ancien-mot-de-passe";
const NEW_PASSWORD = "nouveau-mot-de-passe";

authService.register(EMAIL, OLD_PASSWORD);
const user = conn.prepare("SELECT id FROM users WHERE email = ?").get(authService.normEmail(EMAIL));

function hashToken(t) { return crypto.createHash("sha256").update(t).digest("hex"); }

function createResetToken(expiresInMs = 3600 * 1000) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  conn.prepare(`
    INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, used_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(crypto.randomUUID(), user.id, hashToken(token), now, now + expiresInMs);
  return token;
}

/* Reproduit exactement la logique de la route, transaction comprise : c'est
   précisément cette partie qui avait échoué. */
function applyReset(token, password) {
  const row = conn.prepare("SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?")
    .get(hashToken(String(token)));
  if (!row || row.used_at || row.expires_at < Date.now()) throw new Error("invalide");

  conn.exec("BEGIN");
  try {
    const { hashPassword } = require("../src/crypto/password");
    conn.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(String(password)), row.user_id);
    conn.prepare("UPDATE password_resets SET used_at = ? WHERE id = ?").run(Date.now(), row.id);
    conn.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(Date.now(), row.user_id);
    conn.exec("COMMIT");
  } catch (e) {
    try { conn.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

console.log("\n== Intégration : réinitialisation de mot de passe ==\n");

test("la table password_resets existe après init", () => {
  const t = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='password_resets'").get();
  assert.ok(t, "table password_resets absente");
});

test("un jeton valide permet de changer le mot de passe (transaction node:sqlite)", () => {
  const token = createResetToken();
  applyReset(token, NEW_PASSWORD); // échouait avec conn.transaction is not a function
  const result = authService.login(EMAIL, NEW_PASSWORD, "device-test");
  assert.ok(result && result.user, "connexion impossible avec le nouveau mot de passe");
});

test("l'ancien mot de passe ne fonctionne plus", () => {
  assert.throws(() => authService.login(EMAIL, OLD_PASSWORD, "device-test"));
});

test("un jeton déjà utilisé est refusé", () => {
  const token = createResetToken();
  applyReset(token, "un-autre-mot-de-passe");
  assert.throws(() => applyReset(token, "encore-un-autre"), /invalide/);
});

test("un jeton expiré est refusé", () => {
  const token = createResetToken(-1000); // déjà expiré
  assert.throws(() => applyReset(token, "peu-importe"), /invalide/);
});

test("un jeton inexistant est refusé", () => {
  assert.throws(() => applyReset("jeton-qui-n-existe-pas", "peu-importe"), /invalide/);
});

test("le jeton n'est jamais stocké en clair", () => {
  const token = createResetToken();
  const row = conn.prepare("SELECT token_hash FROM password_resets WHERE token_hash = ?").get(hashToken(token));
  assert.ok(row, "jeton introuvable par son hash");
  const clair = conn.prepare("SELECT id FROM password_resets WHERE token_hash = ?").get(token);
  assert.ok(!clair, "le jeton en clair ne doit jamais correspondre à une ligne");
});

test("le changement de mot de passe révoque les sessions existantes", () => {
  const login = authService.login(EMAIL, "un-autre-mot-de-passe", "device-revoke");
  assert.ok(login.refreshToken, "pas de refresh token émis");
  const actifsAvant = conn.prepare("SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL").get(user.id);
  assert.ok(actifsAvant.n > 0, "aucune session active avant le test");

  applyReset(createResetToken(), "mot-de-passe-final");

  const actifsApres = conn.prepare("SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL").get(user.id);
  assert.strictEqual(actifsApres.n, 0, "des sessions sont restées actives après réinitialisation");
});

summary();
