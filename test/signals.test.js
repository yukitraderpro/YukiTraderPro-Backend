/* BACKEND_9 — la mesure des signaux, EXÉCUTÉE : des signaux consignés, des
   bougies inventées mais précises, et le verdict attendu à chaque fois. */
const test = require("node:test");
const assert = require("node:assert");
const { createSignals, judge, candleEpoch, MIN_SIGNALS_FOR_STATS } = require("../src/services/signalsService");
const db = require("../src/db");

const NY = (d, hm) => d + " " + hm + ":00"; // heure de New York, comme Twelve Data
const T0 = Date.UTC(2026, 8, 4, 14, 0, 0); // vendredi 4/9, 10:00 NY = 16:00 Paris
function c(hm, open, high, low, close) { return { datetime: NY("2026-09-04", hm), open, high, low, close, volume: 1 }; }
const BUY = { side: "BUY", entry: 100, stop: 99.5, target1: 100.75, target2: 101.25, valid_minutes: 120, emitted_at: T0, market_kind: "us" };

test("candleEpoch : « 2026-09-04 10:00:00 » en heure de New York = 14:00 UTC (heure d'été)", () => {
  assert.strictEqual(candleEpoch("2026-09-04 10:00:00", "us"), T0);
  assert.strictEqual(candleEpoch("2026-12-04 10:00:00", "us"), Date.UTC(2026, 11, 4, 15, 0, 0), "heure d'hiver : 15:00 UTC");
  assert.strictEqual(candleEpoch("2026-09-04 10:00:00", "fx"), Date.UTC(2026, 8, 4, 10, 0, 0), "forex : UTC");
});

test("judge — achat : objectif 1 touché avant le stop → target1 ; stop d'abord → stop ; rien → expired ; fenêtre non couverte → null", () => {
  const now = T0 + 3 * 3600000;
  assert.deepStrictEqual(judge(BUY, [c("10:15", 100, 100.8, 99.9, 100.6)], now), { outcome: "target1", ret_pct: 0.75, t2_reached: 0 });
  assert.deepStrictEqual(judge(BUY, [c("10:15", 100, 100.3, 99.4, 99.6)], now), { outcome: "stop", ret_pct: -0.5, t2_reached: 0 });
  /* BACKEND_11 : « le stop l'emporte » biaisait la mesure (voir le test dédié plus bas) — c'est désormais indéterminé. */
  const j = judge(BUY, [c("10:15", 100, 100.9, 99.4, 99.6)], now);
  assert.strictEqual(j.outcome, "undetermined", "une bougie qui touche les deux ne dit pas lequel est venu en premier");
  const flat = [c("10:15", 100, 100.2, 99.8, 100.1), c("11:00", 100.1, 100.3, 99.9, 100.2), c("11:45", 100.2, 100.4, 100, 100.3), c("12:00", 100.3, 100.4, 100.1, 100.2)];
  const ex = judge(BUY, flat, now); assert.strictEqual(ex.outcome, "expired"); assert.ok(Math.abs(ex.ret_pct - 0.2) < 1e-9, "rendement du dernier cours : " + ex.ret_pct);
  assert.strictEqual(judge(BUY, [c("10:15", 100, 100.2, 99.8, 100.1)], T0 + 30 * 60000), null, "validité pas écoulée : on attend");
  assert.strictEqual(judge(BUY, [c("10:15", 100, 100.2, 99.8, 100.1)], now), null, "validité écoulée mais bougies manquantes : on n'invente pas « expiré »");
});

test("judge — objectif 2 après l'objectif 1 : rendement de l'objectif 2 ; vente : niveaux inversés", () => {
  const now = T0 + 3 * 3600000;
  const j = judge(BUY, [c("10:15", 100, 100.8, 99.9, 100.7), c("10:30", 100.7, 101.3, 100.6, 101.2)], now);
  assert.strictEqual(j.outcome, "target1"); assert.strictEqual(j.t2_reached, 1); assert.strictEqual(j.ret_pct, 1.25);
  const SELL = { ...BUY, side: "SELL", stop: 100.5, target1: 99.25, target2: 98.75 };
  assert.strictEqual(judge(SELL, [c("10:15", 100, 100.2, 99.2, 99.3)], now).outcome, "target1");
  assert.strictEqual(judge(SELL, [c("10:15", 100, 100.6, 99.8, 100.4)], now).outcome, "stop");
  assert.strictEqual(judge(SELL, [c("10:15", 100, 100.2, 99.2, 99.3)], now).ret_pct, 0.75, "gain positif sur une vente qui baisse");
});

test("service — consigner (doublon ignoré), résoudre avec une série serveur, statistiques simples et détaillées", async () => {
  db.open(":memory:");
  let now = T0 + 5 * 3600000;
  const series = [c("10:15", 100, 100.8, 99.9, 100.6), c("10:30", 100.6, 100.9, 100.4, 100.5)];
  const market = { configured: () => true, series: async () => ({ values: series }) };
  const s = createSignals({ getDb: () => db.get(), market, now: () => now });
  const sig = { itemId: "NVDA", symbol: "NVDA", profile: "day", origin: "analysis", signal: "ACHAT", entry: 100, stop: 99.5, target1: 100.75, target2: 101.25, validMinutes: 120, stars: 3, emittedAt: T0, marketKind: "us" };
  assert.deepStrictEqual(s.record("u1", sig), { recorded: true });
  assert.deepStrictEqual(s.record("u1", sig), { recorded: false }, "même signal, même minute : ignoré");
  assert.throws(() => s.record("u1", { ...sig, entry: "abc" }), /entry/);
  for (let i = 0; i < 25; i++) s.record("u" + (i % 5), { ...sig, itemId: "SMH", symbol: "SMH", emittedAt: T0 + i * 60000, stars: 2 + (i % 3) });
  const r = await s.resolvePending();
  assert.strictEqual(r.resolved, 26); assert.strictEqual(r.pending, 0);
  const st = s.stats({ days: 30, userId: "u1" });
  assert.strictEqual(st.overall.count, 26); assert.strictEqual(st.enough, true); assert.strictEqual(st.minSignals, MIN_SIGNALS_FOR_STATS);
  assert.strictEqual(st.overall.target1Pct, 100, "toutes ont touché l'objectif 1");
  assert.strictEqual(st.byProfile[0].key, "day");
  assert.ok(st.byStars.length === 3, "détail par étoiles");
  assert.ok(st.byInstrument.find(x => x.key === "SMH").count === 25, "détail par instrument (≥ 5 signaux)");
  assert.strictEqual(st.mine, 6, "les signaux de l'utilisateur : 1 NVDA + 5 SMH");
  assert.strictEqual(st.pending, 0);
});

test("service — sans clé serveur, rien n'est résolu ; sous 20 signaux, « enough » est faux (on ne publie pas un pourcentage sur 3 cas)", async () => {
  db.open(":memory:");
  let now = T0 + 5 * 3600000;
  const s = createSignals({ getDb: () => db.get(), market: { configured: () => false }, now: () => now });
  s.record("u1", { itemId: "NVDA", symbol: "NVDA", profile: "day", signal: "ACHAT", entry: 100, stop: 99.5, target1: 100.75, target2: 101.25, validMinutes: 120, emittedAt: T0 });
  assert.deepStrictEqual(await s.resolvePending(), { resolved: 0, pending: 1 });
  const st = s.stats({ days: 30 });
  assert.strictEqual(st.enough, false); assert.strictEqual(st.pending, 1); assert.strictEqual(st.overall.count, 0);
});

test("BACKEND_11 — une bougie qui touche stop ET objectif est INDÉTERMINÉE, pas un stop (constat Simon 13/09 : 41 % de stops, 0 % d'objectifs sur bougies 1 h)", () => {
  const now = T0 + 7 * 3600000;
  const both = [c("10:15", 100, 100.9, 99.4, 100.2)];
  assert.deepStrictEqual(judge(BUY, both, now), { outcome: "undetermined", ret_pct: null, t2_reached: 0 });
  assert.strictEqual(judge(BUY, [c("10:15", 100, 100.8, 99.9, 100.6)], now).outcome, "target1", "objectif seul : inchangé");
  assert.strictEqual(judge(BUY, [c("10:15", 100, 100.3, 99.4, 99.5)], now).outcome, "stop", "stop seul : inchangé");
  const SELL = { ...BUY, side: "SELL", stop: 100.5, target1: 99.25, target2: 98.75 };
  assert.strictEqual(judge(SELL, [c("10:15", 100, 100.6, 99.2, 99.8)], now).outcome, "undetermined", "vente : même règle");
});

test("BACKEND_11 — les indéterminés sortent des pourcentages et sont comptés à part ; la mesure demande toujours des bougies de 15 min", async () => {
  db.open(":memory:");
  let now = T0 + 5 * 3600000;
  const asked = [];
  const market = { configured: () => true, series: async (p) => { asked.push(p); return { values: [c("10:15", 100, 100.9, 99.4, 100.2)] }; } };
  const s = createSignals({ getDb: () => db.get(), market, now: () => now });
  const base = { itemId: "NVDA", symbol: "NVDA", profile: "day", signal: "ACHAT", entry: 100, stop: 99.5, target1: 100.75, target2: 101.25, validMinutes: 120, stars: 3, marketKind: "us" };
  for (let i = 0; i < 5; i++) s.record("u1", { ...base, emittedAt: T0 + i * 60000 });
  await s.resolvePending();
  assert.strictEqual(asked[0].interval, "15min", "jamais 1 h : une bougie d'une heure est plus large que la distance aux niveaux");
  assert.ok(asked[0].outputsize >= 120, "on remonte en nombre de bougies : " + asked[0].outputsize);
  const st = s.stats({ days: 30 });
  assert.strictEqual(st.overall.count, 0, "aucun résultat exploitable");
  assert.strictEqual(st.overall.undetermined, 5, "les cinq sont comptés à part");
  assert.strictEqual(st.enough, false, "et rien n'est publié");
});

test("BACKEND_11 — les verdicts rendus avant le correctif sont remis en attente, une seule fois", async () => {
  db.open(":memory:");
  let now = T0 + 5 * 3600000;
  const market = { configured: () => true, series: async () => ({ values: [c("10:15", 100, 100.8, 99.9, 100.6)] }) };
  const s = createSignals({ getDb: () => db.get(), market, now: () => now });
  const base = { itemId: "NVDA", symbol: "NVDA", profile: "day", signal: "ACHAT", entry: 100, stop: 99.5, target1: 100.75, target2: 101.25, validMinutes: 120, marketKind: "us" };
  for (let i = 0; i < 3; i++) s.record("u1", { ...base, emittedAt: T0 + i * 60000 });
  await s.resolvePending();
  assert.strictEqual(s.stats({ days: 30 }).overall.count, 3);
  assert.deepStrictEqual(s.rejudgeLegacy(), { reset: 3, alreadyDone: false });
  assert.strictEqual(s.stats({ days: 30 }).overall.count, 0, "remis en attente");
  assert.strictEqual(s.stats({ days: 30 }).pending, 3);
  assert.deepStrictEqual(s.rejudgeLegacy(), { reset: 0, alreadyDone: true }, "jamais deux fois");
  await s.resolvePending();
  assert.strictEqual(s.stats({ days: 30 }).overall.count, 3, "rejugés proprement");
});

test("BACKEND_12 — signal miroir : sens opposé, mêmes distances ; jugé en même temps que le signal", async () => {
  const { mirrorOf } = require("../src/services/signalsService");
  const m = mirrorOf({ side: "BUY", entry: 100, stop: 99.5, target1: 100.75, target2: 101.25 });
  assert.deepStrictEqual([m.side, m.stop, m.target1, m.target2], ["SELL", 100.5, 99.25, 98.75]);
  db.open(":memory:");
  let now = T0 + 5 * 3600000;
  const s = createSignals({ getDb: () => db.get(), market: { configured: () => true, series: async () => ({ values: [c("10:15", 100, 100.3, 99.2, 99.4)] }) }, now: () => now });
  s.record("u1", { itemId: "NVDA", symbol: "NVDA", profile: "day", signal: "ACHAT", entry: 100, stop: 99.5, target1: 100.75, target2: 101.25, validMinutes: 120, emittedAt: T0, marketKind: "us" });
  await s.resolvePending();
  const row = s.recent(1)[0];
  assert.strictEqual(row.outcome, "stop"); assert.strictEqual(row.mirror_outcome, "target1", "la baisse qui stoppe l'achat fait gagner la vente miroir");
  const st = s.stats({ days: 30 });
  assert.strictEqual(st.mirror.count, 1); assert.strictEqual(st.mirror.target1Pct, 100);
});

test("BACKEND_12 — observations du suivi (vérité terrain) rapprochées des verdicts ; la carte n'est validée qu'avec 10 rapprochements à 80 % d'accord", async () => {
  db.open(":memory:");
  let now = T0 + 5 * 3600000;
  const s = createSignals({ getDb: () => db.get(), market: { configured: () => true, series: async () => ({ values: [c("10:15", 100, 100.8, 99.9, 100.6)] }) }, now: () => now });
  for (let i = 0; i < 12; i++) {
    s.record("u" + i, { itemId: "NVDA", symbol: "NVDA", profile: "day", signal: "ACHAT", entry: 100, stop: 99.5, target1: 100.75, target2: 101.25, validMinutes: 120, emittedAt: T0 + i * 60000, marketKind: "us" });
    assert.deepStrictEqual(s.observe("u" + i, { itemId: "NVDA", symbol: "NVDA", side: "BUY", entry: 100, observed: i < 11 ? "target1" : "stop", price: 100.8, openedAt: T0 + i * 60000 }), { recorded: true });
  }
  assert.deepStrictEqual(s.observe("u0", { symbol: "NVDA", side: "BUY", entry: 100, observed: "target1", openedAt: T0 }), { recorded: false }, "doublon ignoré");
  assert.throws(() => s.observe("u0", { symbol: "NVDA", side: "BUY", entry: 100, observed: "maybe" }), /invalide/);
  await s.resolvePending();
  const rec = s.reconcile(30);
  assert.strictEqual(rec.observations, 12); assert.strictEqual(rec.matched, 12); assert.strictEqual(rec.agree, 11, "11 « objectif » d'accord, 1 « stop » en désaccord");
  assert.strictEqual(rec.disagreements[0].judged, "target1");
  const st = s.stats({ days: 30 });
  assert.strictEqual(st.validated, true, "12 rapprochements, 92 % d'accord");
  assert.strictEqual(st.reconciliation.matched, 12);
});
