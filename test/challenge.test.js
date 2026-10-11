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

test("BACKEND_16 — niveaux du défi : 1 point par bonne réponse, 2 à partir du 3e jour juste d'affilée ; paliers nommés ; calculé sur tout l'historique", async () => {
  db.open(":memory:");
  const s = createChallenge({ getDb: () => db.get(), market: { configured: () => true, series: async () => ({ values: [] }), price: async () => ({ price: 100 }) }, now: () => Date.UTC(2026, 9, 11, 20, 0) });
  const { levelFor } = s;
  assert.deepStrictEqual(levelFor(0), { level: 1, key: "flocon", start: 0, nextAt: 3, toNext: 3 });
  assert.deepStrictEqual(levelFor(3), { level: 2, key: "premiere_neige", start: 3, nextAt: 7, toNext: 4 });
  assert.strictEqual(levelFor(12).key, "congere"); assert.strictEqual(levelFor(64).level, 7);
  assert.deepStrictEqual(levelFor(65), { level: 8, key: "neiges_eternelles", start: 65, nextAt: 90, toNext: 25 });
  assert.deepStrictEqual(levelFor(91), { level: 9, key: "neiges_eternelles", start: 90, nextAt: 115, toNext: 24 }, "au-delà : un niveau tous les 25 points");
  s.stats("u1"); /* force la création du schéma */
  const d = db.get();
  const ins = d.prepare("INSERT INTO challenges (user_id, day, item_id, symbol, user_call, yuki_call, ref_price, close_price, user_result, yuki_result, picked_at) VALUES ('u1', ?, 'NVDA', 'NVDA', 'up', 'up', 100, 101, ?, 'win', 0)");
  /* win, win, win, loss, win, pass, win, win, win → 1+1+2 · 0 · 1 · (passe : série conservée) · 1+2+2 = 10 */
  const seq = ["win", "win", "win", "loss", "win", "pass", "win", "win", "win"];
  seq.forEach((r, i) => ins.run("2026-09-" + String(10 + i).padStart(2, "0"), r));
  const p = s.progression("u1");
  assert.strictEqual(p.points, 10, "série : 3e jour juste = 2 points ; une perte remet la série à zéro ; « je passe » n'interrompt pas");
  assert.strictEqual(p.level, 3); assert.strictEqual(p.key, "poudreuse"); assert.strictEqual(p.toNext, 2); assert.strictEqual(p.lastGain, 2);
  const st = s.stats("u1");
  assert.strictEqual(st.progress.points, 10, "la progression voyage avec les statistiques");
  assert.deepStrictEqual(s.progression("inconnu"), { points: 0, lastGain: 0, level: 1, key: "flocon", start: 0, nextAt: 3, toNext: 3 });
});
