#!/usr/bin/env node
/* Tests de la suppression de compte (RGPD + exigence Google Play 2024).
   Base SQLite en mémoire : on crée un compte avec des données dans toutes les
   tables liées, puis on vérifie que la suppression est complète et sûre. */
const assert = require("assert");
process.env.DB_PATH = ":memory:";

let ok = 0, ko = 0;
function test(label, fn) {
  try { fn(); console.log("  ✓ " + label); ok++; }
  catch (e) { console.error("  ✗ " + label + " — " + e.message); ko++; }
}

const db = require("../src/db");
db.open(":memory:");
const authService = require("../src/services/authService");
const conn = db.get();

function makeUser(email) {
  const user = authService.register(email, "MotDePasse123");
  const id = user.id;
  /* On sème des données dans chaque table liée à l'utilisateur. */
  conn.prepare("INSERT INTO devices (id, user_id, label, platform, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?)")
      .run("dev-" + id, id, "Téléphone", "android", Date.now(), Date.now());
  conn.prepare("INSERT INTO sync_state (user_id, payload, updated_at, version) VALUES (?,?,?,?)")
      .run(id, JSON.stringify({ signals: [{ name: "NVIDIA" }], apiKey: "SECRET" }), Date.now(), 1);
  conn.prepare("INSERT INTO notification_tokens (id, user_id, fcm_token, created_at) VALUES (?,?,?,?)")
      .run("tok-" + id, id, "fcm-token-abc", Date.now());
  conn.prepare("INSERT INTO audit_log (id, user_id, action, meta, created_at) VALUES (?,?,?,?,?)")
      .run("aud-" + id, id, "login", "{}", Date.now());
  return id;
}
function countFor(table, id) {
  try { return conn.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(id).n; }
  catch { return -1; }
}

test("Un mot de passe incorrect n'efface rien", () => {
  const id = makeUser("wrong@example.com");
  assert.throws(() => authService.deleteAccount(id, "MauvaisMotDePasse"), /Mot de passe incorrect/);
  assert.strictEqual(conn.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(id).n, 1,
    "le compte a été supprimé malgré un mot de passe faux");
  assert.strictEqual(countFor("sync_state", id), 1, "des données ont été perdues");
});

test("Un mot de passe vide ou absent est refusé", () => {
  const id = makeUser("empty@example.com");
  assert.throws(() => authService.deleteAccount(id, ""), /Mot de passe incorrect/);
  assert.throws(() => authService.deleteAccount(id, undefined), /Mot de passe incorrect/);
  assert.strictEqual(conn.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(id).n, 1);
});

test("Avec le bon mot de passe, le compte et TOUTES les données liées disparaissent", () => {
  const id = makeUser("delete@example.com");
  const res = authService.deleteAccount(id, "MotDePasse123");
  assert.strictEqual(res.deleted, true);
  assert.strictEqual(conn.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(id).n, 0, "compte encore présent");
  for (const table of ["devices", "sync_state", "notification_tokens", "refresh_tokens", "subscriptions", "user_offer_assignments"]) {
    assert.strictEqual(countFor(table, id), 0, `des données subsistent dans ${table}`);
  }
});

test("Les données personnelles (analyses, clé API) ne subsistent nulle part", () => {
  const id = makeUser("secret@example.com");
  authService.deleteAccount(id, "MotDePasse123");
  /* Portée : uniquement les lignes de CE compte (les autres tests laissent
     volontairement des comptes intacts dans la base partagée). */
  const rows = conn.prepare("SELECT payload FROM sync_state WHERE user_id = ?").all(id);
  assert.strictEqual(rows.length, 0, "les données du compte supprimé sont encore présentes");
});

test("Les journaux d'audit sont anonymisés, pas détruits (traçabilité de sécurité)", () => {
  const id = makeUser("audit@example.com");
  authService.deleteAccount(id, "MotDePasse123");
  assert.strictEqual(countFor("audit_log", id), 0, "l'identifiant réel subsiste dans les journaux");
  /* La ligne d'audit de CE compte doit exister encore, mais anonymisée. */
  const row = conn.prepare("SELECT user_id FROM audit_log WHERE id = ?").get("aud-" + id);
  assert.ok(row, "le journal d'audit a été détruit au lieu d'être anonymisé");
  assert.ok(String(row.user_id).startsWith("deleted-"),
    `anonymisation non appliquée (user_id = ${row.user_id})`);
});

test("L'e-mail est libéré : on peut recréer un compte avec la même adresse", () => {
  const id = makeUser("reuse@example.com");
  authService.deleteAccount(id, "MotDePasse123");
  const again = authService.register("reuse@example.com", "AutreMotDePasse1");
  assert.ok(again && again.id && again.id !== id, "impossible de recréer un compte");
});

test("Supprimer un compte inexistant échoue proprement", () => {
  assert.throws(() => authService.deleteAccount("id-qui-nexiste-pas", "x"), /introuvable/);
});

test("La suppression d'un compte n'affecte pas les autres utilisateurs", () => {
  const a = makeUser("a@example.com"), b = makeUser("b@example.com");
  authService.deleteAccount(a, "MotDePasse123");
  assert.strictEqual(conn.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(b).n, 1,
    "un autre compte a été supprimé");
  assert.strictEqual(countFor("sync_state", b), 1, "les données d'un autre utilisateur ont été touchées");
});

test("Le statut d'abonnement est signalé pour avertir de la résiliation Play", () => {
  const id = makeUser("sub@example.com");
  conn.prepare("UPDATE users SET subscribed = 1 WHERE id = ?").run(id);
  const res = authService.deleteAccount(id, "MotDePasse123");
  assert.strictEqual(res.hadSubscription, true, "l'abonnement actif n'est pas signalé");
});

console.log(`\n${ok} test(s) réussi(s), ${ko} échec(s).`);
process.exit(ko ? 1 : 0);
