const assert = require("assert");
const fs = require("fs");
process.env.DB_PATH = "/tmp/yuki_test_csv_" + Date.now() + ".sqlite";
process.env.LOG_DIR = "/tmp/yuki_test_logs";
process.env.BACKUP_DIR = "/tmp/yuki_test_backups";

const db = require("../src/db");
const svc = require("../src/services/csvImportService");

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n    " + (e.stack || e.message)); } }

console.log("\n== Service d'import CSV (addendum V3.2) ==\n");

db.open();
function seedUser(id) {
  const now = Date.now();
  db.get().prepare(`INSERT INTO users (id, email, password_hash, role, created_at, trial_until, subscribed) VALUES (?, ?, 'x', 'free', ?, ?, 0)`).run(id, id + "@test.local", now, now);
}
seedUser("alice");
seedUser("bob");

const SAMPLE_CSV = "Ticker,Name,Qty,Avg Price,Date\nNVDA,NVIDIA,10,450.5,2026-01-01\nAMD,AMD Inc,5,120,2026-01-02\nBADROW,,-1,0,2026-01-03";

test("createImportPreview parse et propose un mapping automatique", () => {
  const preview = svc.createImportPreview("alice", { filename: "trades.csv", source: "tradingview", destination: "portfolio", csvText: SAMPLE_CSV });
  assert.strictEqual(preview.totalRows, 3);
  assert.strictEqual(preview.suggestedMapping[0], "symbol");
  assert.strictEqual(preview.sampleRows.length, 3);
});

test("createImportPreview rejette une source inconnue", () => {
  assert.throws(() => svc.createImportPreview("alice", { filename: "x.csv", source: "inconnue", destination: "portfolio", csvText: SAMPLE_CSV }));
});

test("createImportPreview rejette un fichier trop volumineux", () => {
  const huge = "a,b\n" + "1,2\n".repeat(2000000);
  assert.throws(() => svc.createImportPreview("alice", { filename: "huge.csv", source: "custom", destination: "portfolio", csvText: huge }));
});

test("createImportPreview rejette un contenu suspect", () => {
  assert.throws(() => svc.createImportPreview("alice", { filename: "x.csv", source: "custom", destination: "portfolio", csvText: "MZ\x90\x00<script>evil()</script>" }));
});

test("createImportPreview rejette une extension non autorisée", () => {
  assert.throws(() => svc.createImportPreview("alice", { filename: "malware.exe", source: "custom", destination: "portfolio", csvText: SAMPLE_CSV }));
});

let firstImportId;
test("confirmImport importe les lignes valides et rapporte les erreurs sans bloquer le reste", () => {
  const preview = svc.createImportPreview("alice", { filename: "trades.csv", source: "tradingview", destination: "portfolio", csvText: SAMPLE_CSV });
  firstImportId = preview.importId;
  const report = svc.confirmImport("alice", firstImportId, { duplicateStrategy: "ignore" });
  assert.strictEqual(report.imported, 2); // NVDA + AMD
  assert.strictEqual(report.errorCount, 1); // BADROW (pas de symbole)
  assert.strictEqual(report.errors[0].errors.length > 0, true);
});

test("le fichier brut n'est plus conservé après confirmation (sécurité)", () => {
  const detail = svc.getImportReport("alice", firstImportId);
  assert.strictEqual(detail.raw_rows_json, null);
});

test("confirmImport rejette un mapping sans colonne symbole (erreur critique = tout annulé)", () => {
  const preview = svc.createImportPreview("alice", { filename: "x.csv", source: "custom", destination: "portfolio", csvText: "a,b\n1,2" });
  assert.throws(() => svc.confirmImport("alice", preview.importId, { mapping: { 0: "quantity", 1: "entryPrice" } }));
});

test("confirmImport ne peut pas être rejoué sur un import déjà confirmé", () => {
  assert.throws(() => svc.confirmImport("alice", firstImportId, {}));
});

test("réimporter le même fichier avec la stratégie 'ignore' ne crée pas de doublons", () => {
  const preview = svc.createImportPreview("alice", { filename: "trades.csv", source: "tradingview", destination: "portfolio", csvText: SAMPLE_CSV });
  const report = svc.confirmImport("alice", preview.importId, { duplicateStrategy: "ignore" });
  assert.strictEqual(report.imported, 0);
  assert.strictEqual(report.skipped, 2);
});

test("réimporter avec la stratégie 'replace' met à jour les lignes existantes", () => {
  const preview = svc.createImportPreview("alice", { filename: "trades.csv", source: "tradingview", destination: "portfolio", csvText: SAMPLE_CSV });
  const report = svc.confirmImport("alice", preview.importId, { duplicateStrategy: "replace" });
  assert.strictEqual(report.updated, 2);
});

test("réimporter avec la stratégie 'create_new' crée des lignes supplémentaires", () => {
  const before = svc.listRows("alice", { source: "tradingview" }).length;
  const preview = svc.createImportPreview("alice", { filename: "trades.csv", source: "tradingview", destination: "portfolio", csvText: SAMPLE_CSV });
  svc.confirmImport("alice", preview.importId, { duplicateStrategy: "create_new" });
  const after = svc.listRows("alice", { source: "tradingview" }).length;
  assert.strictEqual(after, before + 2);
});

test("le mapping est mémorisé par source pour accélérer les imports suivants", () => {
  const remembered = svc.getRememberedMapping("alice", "tradingview");
  assert.ok(remembered);
  assert.strictEqual(remembered[0], "symbol");
});

test("listRows applique les filtres (ex. ticker)", () => {
  const rows = svc.listRows("alice", { ticker: "NVDA" });
  assert.ok(rows.length > 0);
  rows.forEach(r => assert.strictEqual(r.symbol, "NVDA"));
});

let freshImportId;
test("previewDeletionImpact indique le nombre de lignes concernées avant confirmation", () => {
  const preview = svc.createImportPreview("alice", { filename: "fresh.csv", source: "custom", destination: "watchlist", csvText: "Ticker,Qty\nGOOG,3\nMETA,7" });
  freshImportId = preview.importId;
  svc.confirmImport("alice", freshImportId, {});
  const impact = svc.previewDeletionImpact("alice", freshImportId);
  assert.strictEqual(impact.affectedRows, 2);
  assert.strictEqual(impact.importId, freshImportId);
});

test("suppression sélective (option 3) ne supprime que les lignes choisies", () => {
  const rows = svc.listRows("alice", { importId: freshImportId });
  const before = rows.length;
  const result = svc.softDeleteRows("alice", freshImportId, [rows[0].id]);
  assert.strictEqual(result.rowsAffected, 1);
  const after = svc.listRows("alice", { importId: freshImportId }).length;
  assert.strictEqual(after, before - 1);
});

let deletableImportId;
test("suppression globale (option 2) marque l'import et toutes ses lignes comme supprimés", () => {
  const preview = svc.createImportPreview("bob", { filename: "bob.csv", source: "custom", destination: "watchlist", csvText: "Symbole,Nom,Qty\nTSLA,Tesla,4" });
  deletableImportId = preview.importId;
  svc.confirmImport("bob", deletableImportId, {});
  const result = svc.softDeleteImport("bob", deletableImportId, 30);
  assert.strictEqual(result.rowsAffected, 1);
  assert.ok(result.restoreDeadline > Date.now());
  assert.strictEqual(svc.listRows("bob", {}).length, 0); // ne remonte plus dans les listes normales
});

test("une suppression globale est restaurable pendant le délai prévu", () => {
  const restore = svc.restoreImport("bob", deletableImportId);
  assert.strictEqual(restore.ok, true);
  assert.strictEqual(svc.listRows("bob", {}).length, 1);
});

test("purgeExpired supprime définitivement les imports dont le délai de restauration est dépassé", () => {
  svc.softDeleteImport("bob", deletableImportId, 30);
  // Force le délai dans le passé pour simuler son expiration.
  db.get().prepare("UPDATE csv_imports SET restore_deadline = ? WHERE id = ?").run(Date.now() - 1000, deletableImportId);
  const result = svc.purgeExpired();
  assert.ok(result.purged >= 1);
  assert.throws(() => svc.restoreImport("bob", deletableImportId));
});

test("chaque action est tracée dans le journal d'audit", () => {
  const log = db.get().prepare("SELECT action FROM csv_audit_log WHERE user_id = 'alice' ORDER BY created_at ASC").all();
  const actions = log.map(l => l.action);
  assert.ok(actions.includes("upload"));
  assert.ok(actions.includes("confirm"));
  assert.ok(actions.includes("delete_rows"));
});

/* ---- ISOLATION STRICTE ENTRE UTILISATEURS (règle non négociable n°3) ----- */
test("un utilisateur ne peut pas consulter l'import d'un autre utilisateur", () => {
  assert.throws(() => svc.getImportReport("bob", firstImportId), /introuvable/i);
});
test("un utilisateur ne peut pas supprimer l'import d'un autre utilisateur", () => {
  assert.throws(() => svc.softDeleteImport("bob", firstImportId), /introuvable/i);
});
test("un utilisateur ne peut pas restaurer l'import d'un autre utilisateur", () => {
  assert.throws(() => svc.restoreImport("alice", deletableImportId), /introuvable/i);
});
test("listRows d'un utilisateur ne renvoie jamais les lignes d'un autre utilisateur", () => {
  const aliceRows = svc.listRows("alice", {});
  const bobRows = svc.listRows("bob", {});
  assert.ok(aliceRows.every(r => r.user_id === "alice"));
  assert.ok(bobRows.every(r => r.user_id === "bob"));
});
test("listImports d'un utilisateur ne renvoie jamais les imports d'un autre utilisateur", () => {
  const aliceImports = svc.listImports("alice");
  assert.ok(aliceImports.every(i => i.filename !== "bob.csv"));
});

db.close();
try { fs.unlinkSync(process.env.DB_PATH); } catch {}
try { fs.unlinkSync(process.env.DB_PATH + "-wal"); } catch {}
try { fs.unlinkSync(process.env.DB_PATH + "-shm"); } catch {}

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
process.exit(failed ? 1 : 0);
