const assert = require("assert");
const fs = require("fs");
process.env.DB_PATH = "/tmp/yuki_test_sync_" + Date.now() + ".sqlite";
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
  console.log("\n== Intégration : synchronisation cloud (multi-appareils) ==\n");
  db.open();
  const app = buildApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  const call = makeClient(`http://127.0.0.1:${port}`);

  const reg = await call("POST", "/api/auth/register", { email: "sync@yuki.app", password: "supersecret1", deviceId: "phone" });
  const token = reg.json.accessToken;

  await test("l'état est vide avant toute synchronisation", async () => {
    const r = await call("GET", "/api/sync/state", null, token);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.state, null);
    assert.strictEqual(r.json.version, 0);
  });

  await test("PUT enregistre l'état et incrémente la version", async () => {
    const r = await call("PUT", "/api/sync/state", { state: { favorites: ["NVDA", "AMD"], journal: [{ id: 1 }] } }, token);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.version, 1);
  });

  await test("GET renvoie l'état exact qui a été stocké (round-trip fidèle)", async () => {
    const r = await call("GET", "/api/sync/state", null, token);
    assert.deepStrictEqual(r.json.state, { favorites: ["NVDA", "AMD"], journal: [{ id: 1 }] });
  });

  await test("un second PUT incrémente à nouveau la version (simulateur d'un autre appareil)", async () => {
    const r = await call("PUT", "/api/sync/state", { state: { favorites: ["NVDA", "AMD", "MSFT"], journal: [{ id: 1 }, { id: 2 }] } }, token);
    assert.strictEqual(r.json.version, 2);
  });

  await test("l'accès sans authentification est refusé", async () => {
    const r = await call("GET", "/api/sync/state");
    assert.strictEqual(r.status, 401);
  });

  await test("PUT sans champ `state` est rejeté", async () => {
    const r = await call("PUT", "/api/sync/state", {}, token);
    assert.strictEqual(r.status, 400);
  });

  await test("un utilisateur ne peut pas lire l'état d'un autre utilisateur", async () => {
    const other = await call("POST", "/api/auth/register", { email: "other@yuki.app", password: "supersecret1" });
    const r = await call("GET", "/api/sync/state", null, other.json.accessToken);
    assert.strictEqual(r.json.state, null); // état totalement séparé, pas de fuite
  });

  await test("la liste des appareils reflète les connexions enregistrées", async () => {
    const r = await call("GET", "/api/sync/devices", null, token);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.devices.some(d => d.id === "phone"));
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
