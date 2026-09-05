/* BACKEND_10 — LE DÉFI DU JOUR (« Peux-tu battre Yuki ? »), demande Simon
   04/09 pour l'angle 2 de la campagne. Un jeu, pas une promesse : chaque
   séance, un instrument unique pour tout le monde ; l'utilisateur choisit
   « plus haut » ou « plus bas » à la clôture par rapport au prix du moment,
   ou passe ; au même instant, la lecture day trading de Yuki est figée
   (ACHAT → plus haut, VENTE → plus bas, NEUTRE → Yuki passe). Le soir, le
   serveur lit la clôture RÉELLE et tranche pour les deux. Rien n'est
   investi, rien n'est prédit : on compare deux choix à un cours constaté.
   Mots interdits ici comme ailleurs : « prédiction », « certitude ». */
"use strict";
const { candleEpoch } = require("./signalsService");

/* Instruments du défi : liquides, cotés aux États-Unis, une séance = une clôture nette. */
const CHALLENGE_POOL = ["NVDA", "AAPL", "MSFT", "AMZN", "TSLA", "META", "GOOGL", "AMD", "QQQ", "SPY", "SMH", "VGT", "NFLX", "AVGO", "JPM", "XOM"];

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL, day TEXT NOT NULL,
    item_id TEXT NOT NULL, symbol TEXT NOT NULL, exchange TEXT NOT NULL DEFAULT '',
    ref_price REAL NOT NULL, user_call TEXT NOT NULL, yuki_call TEXT NOT NULL,
    picked_at INTEGER NOT NULL, close_price REAL, resolved_at INTEGER,
    user_result TEXT, yuki_result TEXT,
    UNIQUE(user_id, day)
  )`);
}
function dayOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
function pickOfDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day); const n = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  const symbol = CHALLENGE_POOL[n % CHALLENGE_POOL.length];
  return { itemId: symbol, symbol };
}
function result(call, ref, close) {
  if (call === "pass") return "pass";
  if (close === ref) return "draw";
  return (close > ref) === (call === "up") ? "win" : "loss";
}

function createChallenge({ getDb, market, now = () => Date.now(), logger }) {
  const log = logger || { warn() {} };
  let ready = false;
  const db = () => { const d = getDb(); if (!ready) { ensureSchema(d); ready = true; } return d; };
  const CALLS = ["up", "down", "pass"];

  function today() { return dayOf(now()); }
  function sessionCloseMs(day) { return candleEpoch(day + " 16:00:00", "us"); }

  function record(userId, c) {
    const day = today(), pick = pickOfDay(day);
    if (String(c.symbol || "").toUpperCase() !== pick.symbol) throw new Error("ce n'est pas l'instrument du jour (" + pick.symbol + ")");
    if (!CALLS.includes(c.userCall) || !CALLS.includes(c.yukiCall)) throw new Error("choix invalide");
    const ref = Number(c.refPrice); if (!Number.isFinite(ref) || ref <= 0) throw new Error("prix de référence invalide");
    if (now() >= sessionCloseMs(day)) throw new Error("la séance est terminée, le défi est fermé pour aujourd'hui");
    const r = db().prepare(`INSERT OR IGNORE INTO challenges (user_id, day, item_id, symbol, exchange, ref_price, user_call, yuki_call, picked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, day, pick.itemId, pick.symbol, String(c.exchange || "").toUpperCase().slice(0, 16), ref, c.userCall, c.yukiCall, now());
    return { recorded: r.changes > 0, day, symbol: pick.symbol };
  }

  async function resolvePending(limit = 200) {
    const rows = db().prepare("SELECT * FROM challenges WHERE close_price IS NULL ORDER BY day ASC LIMIT ?").all(limit);
    const due = rows.filter(r => now() >= sessionCloseMs(r.day) + 30 * 60000);
    if (!due.length || !market || !market.configured()) return { resolved: 0, pending: rows.length };
    let resolved = 0;
    const bySymbol = new Map(); for (const r of due) { if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []); bySymbol.get(r.symbol).push(r); }
    for (const [symbol, list] of bySymbol) {
      let values;
      try { const data = await market.series({ symbol, interval: "1day", outputsize: 40 }); values = Array.isArray(data.values) ? data.values : []; }
      catch (e) { log.warn("challenge: clôture indisponible", { symbol, reason: e.message }); continue; }
      const upd = db().prepare("UPDATE challenges SET close_price = ?, resolved_at = ?, user_result = ?, yuki_result = ? WHERE id = ?");
      for (const r of list) {
        const v = values.find(x => String(x.datetime).slice(0, 10) === r.day); if (!v) continue;
        const close = +v.close; if (!Number.isFinite(close)) continue;
        upd.run(close, now(), result(r.user_call, r.ref_price, close), result(r.yuki_call, r.ref_price, close), r.id); resolved++;
      }
    }
    return { resolved, pending: rows.length - resolved };
  }

  function stats(userId, n = 30) {
    const rows = db().prepare("SELECT * FROM challenges WHERE user_id = ? AND close_price IS NOT NULL ORDER BY day DESC LIMIT ?").all(userId, n);
    const played = rows.filter(r => r.user_result !== "pass");
    const yukiPlayed = rows.filter(r => r.yuki_result !== "pass");
    const wins = played.filter(r => r.user_result === "win").length, yukiWins = yukiPlayed.filter(r => r.yuki_result === "win").length;
    let streak = 0; for (const r of rows) { if (r.user_result === "win") streak++; else if (r.user_result === "loss") break; }
    const beat = rows.filter(r => r.user_result === "win" && r.yuki_result !== "win").length;
    return { resolved: rows.length, user: { played: played.length, wins }, yuki: { played: yukiPlayed.length, wins: yukiWins }, streak, beatYuki: beat,
      last: rows.slice(0, 10).map(r => ({ day: r.day, symbol: r.symbol, userCall: r.user_call, yukiCall: r.yuki_call, refPrice: r.ref_price, closePrice: r.close_price, userResult: r.user_result, yukiResult: r.yuki_result })) };
  }

  function todayState(userId) {
    const day = today(), pick = pickOfDay(day);
    const mine = db().prepare("SELECT * FROM challenges WHERE user_id = ? AND day = ?").get(userId, day) || null;
    const closeMs = sessionCloseMs(day);
    return { day, item: pick, closed: now() >= closeMs, closesAt: closeMs, pick: mine ? { userCall: mine.user_call, yukiCall: mine.yuki_call, refPrice: mine.ref_price, closePrice: mine.close_price, userResult: mine.user_result, yukiResult: mine.yuki_result } : null };
  }

  function schedule(intervalMs = 30 * 60000) { const t = setInterval(() => { resolvePending().catch(e => log.warn("challenge: résolution en échec", { reason: e.message })); }, intervalMs); if (t.unref) t.unref(); return t; }

  return { record, resolvePending, stats, todayState, schedule, pickOfDay, result, CHALLENGE_POOL };
}
module.exports = { createChallenge, pickOfDay, result, CHALLENGE_POOL };
