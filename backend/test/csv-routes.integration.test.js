const assert = require("assert");
const fs = require("fs");
process.env.DB_PATH = "/tmp/yuki_test_csv_routes_" + Date.now() + ".sqlite";
process.env.LOG_DIR = "/tmp/yuki_test_logs";
process.env.BACKUP_DIR = "/tmp/yuki_test_backups";

const db = require("../src/db");
const buildApp = require("../src/app");
const { makeClient } = require("./testClient");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n    " + (e.stack || e.message)); } }

async function main() {
  console.log("\n== Intégration HTTP : import CSV (deux utilisateurs) ==\n");
  db.open();
  const app = buildApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;
  const call = makeClient(`http://127.0.0.1:${port}`);

  const regA = await call("POST", "/api/auth/register", { email: "csvA@yuki.app", password: "supersecret1" });
  const regB = await call("POST", "/api/auth/register", { email: "csvB@yuki.app", password: "supersecret1" });
  const tokenA = regA.json.accessToken, tokenB = regB.json.accessToken;

  await test("l'accès sans authentification est refusé", async () => {
    const r = await call("POST", "/api/csv/imports", { filename: "x.csv", source: "custom", destination: "portfolio", csvText: "a,b\n1,2" });
    assert.strictEqual(r.status, 401);
  });

  let importId;
  await test("POST /api/csv/imports crée un aperçu", async () => {
    const r = await call("POST", "/api/csv/imports", {
      filename: "trades.csv", source: "tradingview", destination: "portfolio",
      csvText: "Ticker,Qty,Avg Price\nNVDA,10,450\nAMD,5,120"
    }, tokenA);
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.totalRows, 2);
    importId = r.json.importId;
  });

  await test("POST /api/csv/imports/:id/confirm importe les lignes", async () => {
    const r = await call("POST", `/api/csv/imports/${importId}/confirm`, { duplicateStrategy: "ignore" }, tokenA);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.imported, 2);
  });

  await test("GET /api/csv/imports liste l'historique de l'utilisateur A", async () => {
    const r = await call("GET", "/api/csv/imports", undefined, tokenA);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.imports.some(i => i.id === importId));
  });

  await test("l'utilisateur B ne voit AUCUN import de l'utilisateur A (isolation stricte)", async () => {
    const r = await call("GET", "/api/csv/imports", undefined, tokenB);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.imports.length, 0);
  });

  await test("l'utilisateur B ne peut pas consulter le détail de l'import de A", async () => {
    const r = await call("GET", `/api/csv/imports/${importId}`, undefined, tokenB);
    assert.strictEqual(r.status, 404);
  });

  await test("l'utilisateur B ne peut pas supprimer l'import de A", async () => {
    const r = await call("DELETE", `/api/csv/imports/${importId}`, undefined, tokenB);
    assert.strictEqual(r.status, 404);
  });

  await test("l'utilisateur B ne voit aucune ligne importée par A via GET /api/csv/rows", async () => {
    const r = await call("GET", "/api/csv/rows", undefined, tokenB);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.rows.length, 0);
  });

  await test("l'utilisateur A voit bien ses propres lignes", async () => {
    const r = await call("GET", "/api/csv/rows", undefined, tokenA);
    assert.strictEqual(r.json.rows.length, 2);
  });

  await test("GET /api/csv/imports/:id/impact donne un aperçu avant suppression", async () => {
    const r = await call("GET", `/api/csv/imports/${importId}/impact`, undefined, tokenA);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.affectedRows, 2);
  });

  await test("DELETE avec scope=all met l'import dans la corbeille, restaurable", async () => {
    const del = await call("DELETE", `/api/csv/imports/${importId}?scope=all`, undefined, tokenA);
    assert.strictEqual(del.status, 200);
    assert.ok(del.json.restoreDeadline);
    const rows = await call("GET", "/api/csv/rows", undefined, tokenA);
    assert.strictEqual(rows.json.rows.length, 0);
  });

  await test("POST .../restore restaure l'import supprimé", async () => {
    const r = await call("POST", `/api/csv/imports/${importId}/restore`, undefined, tokenA);
    assert.strictEqual(r.status, 200);
    const rows = await call("GET", "/api/csv/rows", undefined, tokenA);
    assert.strictEqual(rows.json.rows.length, 2);
  });

  await test("un fichier avec contenu suspect est rejeté avec un message clair (400)", async () => {
    const r = await call("POST", "/api/csv/imports", { filename: "x.csv", source: "custom", destination: "portfolio", csvText: "MZ\x90\x00<script>evil()</script>" }, tokenA);
    assert.strictEqual(r.status, 400);
    assert.ok(r.json.error);
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
