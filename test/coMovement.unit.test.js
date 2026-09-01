/* « Ondes de choc » — le co-mouvement est MESURÉ, jamais deviné.
   Tests sans réseau : séries synthétiques, fetch simulé, base temporaire. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"); const os = require("os"); const path = require("path");

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "yuki-ondes-"));
process.env.DB_PATH = path.join(dossier, "test.sqlite");
process.env.JWT_SECRET = "secret-de-test-suffisamment-long-pour-passer";
const db = require("../src/db"); db.open();
const cm = require("../src/services/coMovement");

function serie(closes, start = Date.UTC(2026, 5, 1)) {
  return closes.map((c, i) => ({ datetime: new Date(start + i * 86400000).toISOString().slice(0, 10), close: String(c) }));
}
/* marche aléatoire déterministe */
function marche(n, seed) { let x = seed, p = 100; const out = []; for (let i = 0; i < n; i++) { x = (x * 9301 + 49297) % 233280; const r = (x / 233280 - 0.5) * 0.04; p *= 1 + r; out.push(p); } return out; }

test("corrélation et accord de sens : jumeaux ≈ 1, miroirs ≈ -1", () => {
  const a = marche(80, 7);
  const jumeau = a.map(v => v * 1.5);
  const miroir = [100]; for (let i = 1; i < a.length; i++) miroir.push(miroir[i - 1] * (1 - (a[i] / a[i - 1] - 1)));
  const A = new Map(serie(a).map(v => [v.datetime, Number(v.close)]));
  const J = new Map(serie(jumeau).map(v => [v.datetime, Number(v.close)]));
  const M = new Map(serie(miroir).map(v => [v.datetime, Number(v.close)]));
  let r = cm.alignedReturns(A, J); assert.ok(cm.pearson(r.ra, r.rb) > 0.99); assert.ok(cm.agreement(r.ra, r.rb) > 0.99);
  r = cm.alignedReturns(A, M); assert.ok(cm.pearson(r.ra, r.rb) < -0.99); assert.ok(cm.agreement(r.ra, r.rb) < 0.01);
  assert.strictEqual(r.ra.length, 60, "fenêtre de 60 rendements");
});

test("les séries sont alignées sur les dates communes (jours fériés différents)", () => {
  const A = new Map([["2026-06-01", 100], ["2026-06-02", 101], ["2026-06-03", 102], ["2026-06-04", 103]]);
  const B = new Map([["2026-06-01", 50], ["2026-06-03", 51], ["2026-06-04", 52]]);
  const { ra, rb } = cm.alignedReturns(A, B, 60);
  assert.strictEqual(ra.length, 2); assert.strictEqual(rb.length, 2);
});

test("moins de 20 séances communes → aucune mesure (pas de faux chiffre)", () => {
  assert.strictEqual(cm.pearson([0.01, 0.02], [0.01, 0.02]), null);
  assert.strictEqual(cm.agreement(new Array(10).fill(0.01), new Array(10).fill(0.01)), null);
});

test("computeAll : fetch simulé, délai nul, lignes en base, lecture par symbole", async () => {
  const base = marche(80, 11);
  const fake = async url => {
    const sym = decodeURIComponent(url.match(/symbol=([^&]+)/)[1]);
    let closes = base.map((v, i) => v * (1 + Math.sin(i + sym.length) * 0.002)); // quasi-jumeau
    if (sym === "SMH") closes = base.map(v => v * 2); if (sym === "NVDA") closes = base;
    return { json: async () => ({ values: serie(closes).reverse() }) };
  };
  const res = await cm.computeAll({ apiKey: "cle-test", fetchImpl: fake, delayMs: 0, now: 1234 });
  assert.ok(res.rows > 0, "aucune ligne calculée"); assert.strictEqual(res.failed.length, 0);
  const nvda = cm.linksFor("nvda");
  assert.ok(nvda.asMover, "NVDA doit être une société émettrice");
  const smh = nvda.asMover.mesures.find(m => m.symbol === "SMH");
  assert.ok(smh && smh.corr > 0.99, "SMH doit ressortir comme couplé à NVDA");
  const vuDeSmh = cm.linksFor("SMH");
  assert.ok(vuDeSmh.asLinked.some(x => x.mover === "NVDA" && x.corr > 0.99), "vu depuis SMH, NVDA doit apparaître");
});

test("un symbole inconnu répond proprement, sans erreur", () => {
  const r = cm.linksFor("ZZZZ");
  assert.strictEqual(r.asMover, null); assert.deepStrictEqual(r.asLinked, []);
});

test("la carte ne contient aucun mot de direction", () => {
  const txt = JSON.stringify(cm.RELATIONS).toLowerCase();
  for (const mot of ["à la hausse", "à la baisse", "va monter", "va baisser"]) assert.ok(!txt.includes(mot), "mot interdit : " + mot);
});
