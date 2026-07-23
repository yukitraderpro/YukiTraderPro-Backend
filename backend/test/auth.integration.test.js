const assert = require("assert");
const fs = require("fs");
process.env.DB_PATH = "/tmp/yuki_test_auth_" + Date.now() + ".sqlite";
process.env.LOG_DIR = "/tmp/yuki_test_logs";
process.env.BACKUP_DIR = "/tmp/yuki_test_backups";

const db = require("../src/db");
const buildApp = require("../src/app");
const { makeClient } = require("./testClient");
const config = require("../src/config");

const REFRESH_COOKIE = config.refreshCookieName;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + (e.stack || e.message)); }
}

async function main() {
  console.log("\n== Intégration : authentification JWT (V4 — refresh token en cookie HttpOnly) ==\n");
  db.open();
  const app = buildApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  const call = makeClient(`http://127.0.0.1:${port}`);

  let accessToken, userId;

  await test("l'inscription crée un compte, renvoie un accessToken et pose le cookie refresh (jamais dans le JSON)", async () => {
    const r = await call("POST", "/api/auth/register", { email: "alice@yuki.app", password: "supersecret1", deviceId: "dev-a" });
    assert.strictEqual(r.status, 201);
    assert.ok(r.json.accessToken);
    assert.strictEqual(r.json.refreshToken, undefined, "le refreshToken ne doit JAMAIS apparaître dans le corps JSON (V4 Partie 1.4)");
    assert.ok(call.getCookie(REFRESH_COOKIE), "le cookie refresh doit être posé par le serveur");
    assert.strictEqual(r.json.user.role, "free");
    accessToken = r.json.accessToken; userId = r.json.user.id;
  });

  await test("l'inscription refuse un mot de passe trop court", async () => {
    const r = await call("POST", "/api/auth/register", { email: "bob@yuki.app", password: "123" });
    assert.strictEqual(r.status, 400);
  });

  await test("l'inscription refuse un e-mail déjà utilisé", async () => {
    const r = await call("POST", "/api/auth/register", { email: "alice@yuki.app", password: "supersecret1" });
    assert.strictEqual(r.status, 409);
  });

  await test("/me sans token est rejeté (401)", async () => {
    const r = await call("GET", "/api/auth/me");
    assert.strictEqual(r.status, 401);
  });

  await test("/me avec un bon token renvoie l'utilisateur et son essai actif", async () => {
    const r = await call("GET", "/api/auth/me", null, accessToken);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.user.id, userId);
    assert.strictEqual(r.json.isTrialActive, true);
  });

  await test("le login avec un mauvais mot de passe échoue", async () => {
    const r = await call("POST", "/api/auth/login", { email: "alice@yuki.app", password: "faux" });
    assert.strictEqual(r.status, 401);
  });

  await test("le login avec le bon mot de passe réussit (connexion multi-appareils) et renouvelle le cookie", async () => {
    const r = await call("POST", "/api/auth/login", { email: "alice@yuki.app", password: "supersecret1", deviceId: "dev-b", platform: "android" });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.accessToken);
    assert.strictEqual(r.json.refreshToken, undefined);
    assert.ok(call.getCookie(REFRESH_COOKIE));
  });

  await test("l'utilisateur a bien 2 appareils enregistrés (dev-a, dev-b)", async () => {
    const r = await call("GET", "/api/auth/me", null, accessToken);
    assert.strictEqual(r.json.devices.length, 2);
  });

  await test("refresh (via cookie, sans rien envoyer dans le corps) renvoie un nouvel accessToken et fait tourner le cookie", async () => {
    const before = call.getCookie(REFRESH_COOKIE);
    const r = await call("POST", "/api/auth/refresh", {});
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.accessToken);
    assert.strictEqual(r.json.refreshToken, undefined);
    assert.notStrictEqual(call.getCookie(REFRESH_COOKIE), before, "le cookie doit changer à chaque refresh (rotation)");
  });

  await test("rejouer l'ancien cookie de refresh (déjà consommé) échoue — rotation/anti-replay détectée", async () => {
    const current = call.getCookie(REFRESH_COOKIE);
    const r1 = await call("POST", "/api/auth/refresh", {}); // fait tourner encore une fois
    assert.strictEqual(r1.status, 200);
    call.setCookie(REFRESH_COOKIE, current); // on rejoue l'AVANT-DERNIER cookie, déjà révoqué
    const r2 = await call("POST", "/api/auth/refresh", {});
    assert.strictEqual(r2.status, 401);
  });

  await test("refresh sans cookie (jamais connecté / cookie absent) échoue proprement", async () => {
    const saved = call.getCookie(REFRESH_COOKIE);
    call.clearCookies();
    const r = await call("POST", "/api/auth/refresh", {});
    assert.strictEqual(r.status, 401);
    call.setCookie(REFRESH_COOKIE, saved);
  });

  await test("logout révoque le refresh token courant et efface le cookie", async () => {
    const login = await call("POST", "/api/auth/login", { email: "alice@yuki.app", password: "supersecret1" });
    assert.ok(call.getCookie(REFRESH_COOKIE));
    const activeCookie = call.getCookie(REFRESH_COOKIE);
    const out = await call("POST", "/api/auth/logout", {});
    assert.strictEqual(out.status, 200);
    call.setCookie(REFRESH_COOKIE, activeCookie); // le refresh token doit être révoqué en base, pas seulement le cookie effacé
    const retry = await call("POST", "/api/auth/refresh", {});
    assert.strictEqual(retry.status, 401);
  });

  await test("/api/health répond ok", async () => {
    const r = await call("GET", "/api/health");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, "ok");
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
