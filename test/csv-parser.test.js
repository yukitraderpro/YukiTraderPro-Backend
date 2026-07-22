const assert = require("assert");
const p = require("../src/csv/csvParser");

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n    " + e.message); } }

console.log("\n== Parseur CSV (addendum V3.2) ==\n");

test("detectDelimiter détecte la virgule", () => {
  assert.strictEqual(p.detectDelimiter("a,b,c\n1,2,3"), ",");
});
test("detectDelimiter détecte le point-virgule", () => {
  assert.strictEqual(p.detectDelimiter("a;b;c\n1;2;3"), ";");
});
test("detectDelimiter détecte la tabulation", () => {
  assert.strictEqual(p.detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
});

test("parseCsv gère les champs simples", () => {
  const rows = p.parseCsv("a,b,c\n1,2,3");
  assert.deepStrictEqual(rows, [["a", "b", "c"], ["1", "2", "3"]]);
});
test("parseCsv gère les champs entre guillemets contenant le délimiteur", () => {
  const rows = p.parseCsv('Ticker,Name\nNVDA,"NVIDIA, Corp"');
  assert.deepStrictEqual(rows[1], ["NVDA", "NVIDIA, Corp"]);
});
test("parseCsv gère les guillemets échappés (\"\")", () => {
  const rows = p.parseCsv('a\n"He said ""hi"""');
  assert.strictEqual(rows[1][0], 'He said "hi"');
});
test("parseCsv gère le point-virgule comme délimiteur explicite", () => {
  const rows = p.parseCsv("a;b\n1;2", ";");
  assert.deepStrictEqual(rows, [["a", "b"], ["1", "2"]]);
});
test("parseCsv renvoie un tableau vide pour un texte vide", () => {
  assert.deepStrictEqual(p.parseCsv(""), []);
});

test("looksLikeHeaderRow détecte une ligne d'en-têtes textuelle", () => {
  assert.strictEqual(p.looksLikeHeaderRow(["Ticker", "Qty", "Price"], ["NVDA", "10", "450"]), true);
});
test("looksLikeHeaderRow ne se trompe pas sur des données pures", () => {
  assert.strictEqual(p.looksLikeHeaderRow(["NVDA", "10", "450"], ["AMD", "5", "120"]), false);
});
test("looksLikeHeaderRow suppose un en-tête même sans colonne numérique nulle part (CSV entièrement textuel)", () => {
  assert.strictEqual(p.looksLikeHeaderRow(["Symbole", "Nom"], ["TSLA", "Tesla"]), true);
});

test("suggestMappingForHeaders reconnaît les en-têtes usuels (Ticker, Qty, Avg Price)", () => {
  const m = p.suggestMappingForHeaders(["Ticker", "Qty", "Avg Price", "Date"]);
  assert.strictEqual(m[0], "symbol");
  assert.strictEqual(m[1], "quantity");
  assert.strictEqual(m[2], "entryPrice");
  assert.strictEqual(m[3], "entryAt");
});
test("suggestMappingForHeaders reconnaît les en-têtes français", () => {
  const m = p.suggestMappingForHeaders(["Symbole", "Quantité", "Prix d'entrée"]);
  assert.strictEqual(m[0], "symbol");
  assert.strictEqual(m[1], "quantity");
  assert.strictEqual(m[2], "entryPrice");
});
test("suggestMappingForHeaders laisse une colonne inconnue à null (ne devine jamais au hasard)", () => {
  const m = p.suggestMappingForHeaders(["Colonne mystère 42"]);
  assert.strictEqual(m[0], null);
});

test("normalizeRow applique le mapping et convertit les nombres", () => {
  const record = p.normalizeRow(["NVDA", "10", "450.5"], { 0: "symbol", 1: "quantity", 2: "entryPrice" });
  assert.strictEqual(record.symbol, "NVDA");
  assert.strictEqual(record.quantity, 10);
  assert.strictEqual(record.entryPrice, 450.5);
});
test("normalizeRow gère les nombres au format français (virgule décimale)", () => {
  const record = p.normalizeRow(["NVDA", "450,50"], { 0: "symbol", 1: "entryPrice" });
  assert.strictEqual(record.entryPrice, 450.5);
});
test("normalizeRow neutralise une amorce de formule (protection injection CSV)", () => {
  const record = p.normalizeRow(["=cmd|'/c calc'!A1"], { 0: "symbol" });
  assert.ok(record.symbol.startsWith("'"));
});

test("validateNormalizedRow exige un symbole", () => {
  assert.strictEqual(p.validateNormalizedRow({}).valid, false);
  assert.strictEqual(p.validateNormalizedRow({ symbol: "NVDA" }).valid, true);
});
test("validateNormalizedRow rejette une quantité négative ou nulle", () => {
  assert.strictEqual(p.validateNormalizedRow({ symbol: "NVDA", quantity: -5 }).valid, false);
  assert.strictEqual(p.validateNormalizedRow({ symbol: "NVDA", quantity: 0 }).valid, false);
});

test("computeDedupHash est stable pour la même entrée", () => {
  const r = { symbol: "NVDA", entryAt: "2026-01-01" };
  assert.strictEqual(p.computeDedupHash("user1", "tradingview", r), p.computeDedupHash("user1", "tradingview", r));
});
test("computeDedupHash diffère entre deux utilisateurs (pas de collision inter-comptes)", () => {
  const r = { symbol: "NVDA", entryAt: "2026-01-01" };
  assert.notStrictEqual(p.computeDedupHash("user1", "tradingview", r), p.computeDedupHash("user2", "tradingview", r));
});
test("computeDedupHash diffère entre deux sources pour le même symbole/date", () => {
  const r = { symbol: "NVDA", entryAt: "2026-01-01" };
  assert.notStrictEqual(p.computeDedupHash("user1", "tradingview", r), p.computeDedupHash("user1", "broker", r));
});

test("looksSuspicious détecte un en-tête d'exécutable Windows (MZ)", () => {
  assert.strictEqual(p.looksSuspicious("MZ\x90\x00\x03"), true);
});
test("looksSuspicious détecte une balise <script>", () => {
  assert.strictEqual(p.looksSuspicious("a,b\n<script>alert(1)</script>,2"), true);
});
test("looksSuspicious n'est pas déclenché par un CSV normal", () => {
  assert.strictEqual(p.looksSuspicious("Ticker,Qty\nNVDA,10\nAMD,5"), false);
});

test("isAllowedFile accepte .csv", () => {
  assert.strictEqual(p.isAllowedFile("positions.csv", "text/csv"), true);
});
test("isAllowedFile refuse un exécutable déguisé", () => {
  assert.strictEqual(p.isAllowedFile("positions.csv.exe", "application/octet-stream"), false);
});
test("isAllowedFile refuse un mauvais type MIME même avec la bonne extension", () => {
  assert.strictEqual(p.isAllowedFile("positions.csv", "application/x-msdownload"), false);
});

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
process.exit(failed ? 1 : 0);
