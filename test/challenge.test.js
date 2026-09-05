/* BACKEND_10 — le défi du jour, EXÉCUTÉ : instrument unique par jour, un
   choix par utilisateur, fermeture à la clôture, verdict sur la clôture réelle. */
const test = require("node:test");
const assert = require("node:assert");
const { createChallenge, pickOfDay, result } = require("../src/services/challengeService");
const db = require("../src/db");
const T_OPEN = Date.UTC(2026, 8, 4, 14, 0, 0); // vendredi 4/9, 16 h Paris, séance ouverte

test("instrument du jour : identique pour tout le monde, change chaque jour, tiré d'une liste liquide US", () => {
  assert.strictEqual(pickOfDay("2026-09-04").symbol, pickOfDay("2026-09-04").symbol);
  assert.notStrictEqual(pickOfDay("2026-09-04").symbol, pickOfDay("2026-09-05").symbol);
  assert.deepStrictEqual(result("up", 100, 101), "win"); assert.deepStrictEqual(result("down", 100, 101), "loss"); assert.deepStrictEqual(result("pass", 100, 101), "pass"); assert.deepStrictEqual(result("up", 100, 100), "draw");
});

test("EXÉCUTION — un choix par jour, refus hors instrument du jour et après la clôture, verdict le soir sur la clôture réelle, statistiques", async () => {
  db.open(":memory:");
  let now = T_OPEN;
  const pick = pickOfDay("2026-09-04").symbol;
  const market = { configured: () => true, series: async ({ symbol }) => ({ values: [{ datetime: "2026-09-04", close: "121.00" }, { datetime: "2026-09-03", close: "118.00" }] }) };
  const ch = createChallenge({ getDb: () => db.get(), market, now: () => now });
  assert.deepStrictEqual(ch.record("u1", { symbol: pick, refPrice: 119.42, userCall: "up", yukiCall: "down" }), { recorded: true, day: "2026-09-04", symbol: pick });
  assert.deepStrictEqual(ch.record("u1", { symbol: pick, refPrice: 119.42, userCall: "down", yukiCall: "down" }).recorded, false, "déjà joué");
  assert.throws(() => ch.record("u2", { symbol: "ZZZZ", refPrice: 1, userCall: "up", yukiCall: "up" }), /instrument du jour/);
  assert.throws(() => ch.record("u2", { symbol: pick, refPrice: 1, userCall: "sideways", yukiCall: "up" }), /choix invalide/);
  const st0 = ch.todayState("u1"); assert.strictEqual(st0.closed, false); assert.strictEqual(st0.pick.userCall, "up");
  assert.deepStrictEqual(await ch.resolvePending(), { resolved: 0, pending: 1 }, "avant la clôture, rien à trancher");
  now = Date.UTC(2026, 8, 4, 20, 0, 0) + 31 * 60000; // 22 h 31 Paris
  assert.throws(() => ch.record("u3", { symbol: pick, refPrice: 120, userCall: "up", yukiCall: "up" }), /séance est terminée/);
  assert.deepStrictEqual(await ch.resolvePending(), { resolved: 1, pending: 0 });
  const st = ch.stats("u1");
  assert.strictEqual(st.user.wins, 1); assert.strictEqual(st.yuki.wins, 0); assert.strictEqual(st.streak, 1); assert.strictEqual(st.beatYuki, 1);
  assert.strictEqual(st.last[0].closePrice, 121); assert.strictEqual(st.last[0].userResult, "win"); assert.strictEqual(st.last[0].yukiResult, "loss");
  assert.strictEqual(ch.todayState("u1").closed, true);
});

test("EXÉCUTION — « je passe » ne compte ni victoire ni défaite ; Yuki qui passe ne joue pas ; sans clé serveur rien n'est tranché", async () => {
  db.open(":memory:");
  let now = T_OPEN; const pick = pickOfDay("2026-09-04").symbol;
  const ch = createChallenge({ getDb: () => db.get(), market: { configured: () => false }, now: () => now });
  ch.record("u1", { symbol: pick, refPrice: 100, userCall: "pass", yukiCall: "pass" });
  now = Date.UTC(2026, 8, 5, 8, 0, 0);
  assert.deepStrictEqual(await ch.resolvePending(), { resolved: 0, pending: 1 });
  const ch2 = createChallenge({ getDb: () => db.get(), market: { configured: () => true, series: async () => ({ values: [{ datetime: "2026-09-04", close: "99" }] }) }, now: () => now });
  await ch2.resolvePending();
  const st = ch2.stats("u1"); assert.strictEqual(st.user.played, 0); assert.strictEqual(st.yuki.played, 0); assert.strictEqual(st.resolved, 1);
});
