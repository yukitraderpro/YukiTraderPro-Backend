const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const backupService = require("../src/services/backupService");

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n    " + e.message); } }

console.log("\n== Sauvegardes automatiques ==\n");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yuki-backup-test-"));
const dbPath = path.join(tmpDir, "yuki.sqlite");
const backupDir = path.join(tmpDir, "backups");
fs.writeFileSync(dbPath, "contenu-sqlite-simule");

test("runBackupOnce copie le fichier de base avec un nom horodaté", () => {
  const dest = backupService.runBackupOnce(dbPath, backupDir, 14);
  assert.ok(dest && fs.existsSync(dest));
  assert.ok(path.basename(dest).startsWith("yuki-"));
});

test("runBackupOnce renvoie null si le fichier source n'existe pas", () => {
  const result = backupService.runBackupOnce(path.join(tmpDir, "inexistant.sqlite"), backupDir, 14);
  assert.strictEqual(result, null);
});

test("la rétention supprime les sauvegardes excédentaires (garde les plus récentes)", () => {
  fs.mkdirSync(backupDir, { recursive: true });
  for (const f of fs.readdirSync(backupDir)) fs.unlinkSync(path.join(backupDir, f));
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(backupDir, `yuki-fake-${i}.sqlite`), "x");
  }
  backupService.pruneOldBackups(backupDir, 3);
  const remaining = fs.readdirSync(backupDir).filter(f => f.endsWith(".sqlite"));
  assert.strictEqual(remaining.length, 3);
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
process.exit(failed ? 1 : 0);
