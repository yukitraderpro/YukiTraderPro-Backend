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
  const j = judge(BUY, [c("10:15", 100, 100.9, 99.4, 99.6)], now);
  assert.strictEqual(j.outcome, "stop", "une bougie qui touche les deux : le stop l'emporte (prudence)");
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
