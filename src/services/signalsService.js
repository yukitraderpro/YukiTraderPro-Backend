/* BACKEND_9 — MESURE DES SIGNAUX (demande Simon 04/09 : « on mesure, on ne
   promet pas », enfin possible parce que les données passent au centre).

   Chaque signal AFFICHÉ à un utilisateur (analyse day trading / scalp, ou
   carte d'opportunité) est consigné : instrument, sens, entrée, stop, deux
   objectifs, validité, étoiles, heure d'émission. Puis, une fois sa
   validité écoulée, le serveur relit les bougies de la fenêtre et tranche :
     - « target1 »  : l'objectif 1 a été touché AVANT le stop
     - « stop »     : le stop a été touché d'abord (dans une même bougie qui
                      touche les deux, le stop l'emporte — prudence)
     - « expired »  : ni l'un ni l'autre avant la fin de validité
   Le rendement retenu est celui du niveau touché, ou du dernier cours pour
   un signal expiré. Rien n'est extrapolé : un signal non encore mesurable
   reste « pending » et ne compte dans aucun pourcentage.

   Les statistiques sont GLOBALES (tous utilisateurs) : c'est la précision de
   l'outil qu'on mesure, pas celle d'une personne. Mode Simple : une phrase.
   Mode Expert : par profil, par nombre d'étoiles, par instrument. */
"use strict";

const NY = "America/New_York";
const MIN_SIGNALS_FOR_STATS = 20;

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    exchange TEXT NOT NULL DEFAULT '',
    market_kind TEXT NOT NULL DEFAULT 'us',
    profile TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'analysis',
    side TEXT NOT NULL,
    entry REAL NOT NULL, stop REAL NOT NULL, target1 REAL NOT NULL, target2 REAL NOT NULL,
    valid_minutes INTEGER NOT NULL,
    stars INTEGER NOT NULL DEFAULT 0,
    emitted_at INTEGER NOT NULL,
    emitted_minute INTEGER NOT NULL,
    resolved_at INTEGER,
    outcome TEXT,
    ret_pct REAL,
    t2_reached INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, symbol, profile, side, emitted_minute)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_signals_pending ON signals(outcome, emitted_at)`);
}

/* Bougie Twelve Data « AAAA-MM-JJ HH:MM:SS » en heure de la place → epoch ms. */
function tzOffsetMs(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUtc - ms;
}
function candleEpoch(datetime, kind) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(datetime || ""));
  if (!m) return NaN;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const tz = kind === "us" ? NY : kind === "eu" ? "Europe/Paris" : "UTC";
  if (tz === "UTC") return naive;
  let guess = naive - tzOffsetMs(naive, tz);
  guess = naive - tzOffsetMs(guess, tz);
  return guess;
}

/* Tranche un signal à partir de bougies CHRONOLOGIQUES. Renvoie null si la
   fenêtre n'est pas encore couverte (dernière bougie avant la fin de validité
   et rien de touché). */
function judge(sig, candles, now) {
  const side = sig.side === "SELL" ? -1 : 1;
  const start = sig.emitted_at, end = sig.emitted_at + sig.valid_minutes * 60000;
  let lastClose = null, t1 = false, t2 = false, coveredUntil = start;
  for (const c of candles) {
    const t = candleEpoch(c.datetime, sig.market_kind);
    if (!Number.isFinite(t) || t < start) continue;
    if (t > end) break;
    const hi = +c.high, lo = +c.low, cl = +c.close;
    coveredUntil = t; lastClose = cl;
    const stopHit = side > 0 ? lo <= sig.stop : hi >= sig.stop;
    const t1Hit = side > 0 ? hi >= sig.target1 : lo <= sig.target1;
    const t2Hit = side > 0 ? hi >= sig.target2 : lo <= sig.target2;
    /* BACKEND_11 — une SEULE bougie qui touche le stop ET l'objectif ne dit pas
       lequel est venu en premier. L'ancienne version tranchait « stop » par
       prudence : sur des bougies d'une heure et des niveaux à 0,5 % / 0,75 %,
       cela donnait 41 % de stops et 0 % d'objectifs (constat Simon 13/09).
       Un résultat qu'on ne peut pas établir n'est pas un échec : il est
       INDÉTERMINÉ et sort du pourcentage. */
    if (!t1 && stopHit && t1Hit) return { outcome: "undetermined", ret_pct: null, t2_reached: 0 };
    if (!t1 && stopHit) return { outcome: "stop", ret_pct: (sig.stop - sig.entry) / sig.entry * side * 100, t2_reached: 0 };
    if (t1Hit) t1 = true;
    if (t1 && t2Hit) { t2 = true; break; }
    if (t1 && stopHit) break; /* objectif 1 pris, puis retour sur le stop : on garde l'objectif 1 */
  }
  if (t1) return { outcome: "target1", ret_pct: ((t2 ? sig.target2 : sig.target1) - sig.entry) / sig.entry * side * 100, t2_reached: t2 ? 1 : 0 };
  if (now >= end && lastClose !== null && coveredUntil >= end - 20 * 60000) return { outcome: "expired", ret_pct: (lastClose - sig.entry) / sig.entry * side * 100, t2_reached: 0 };
  return null;
}

function createSignals({ getDb, market, now = () => Date.now(), logger }) {
  const log = logger || { info() {}, warn() {} };
  let ready = false;
  const db = () => { const d = getDb(); if (!ready) { ensureSchema(d); ready = true; } return d; };

  function record(userId, s) {
    const side = s.side === "SELL" || s.signal === "VENTE" ? "SELL" : "BUY";
    const num = k => { const v = Number(s[k]); if (!Number.isFinite(v)) throw new Error("champ " + k + " invalide"); return v; };
    const emittedAt = Number.isFinite(+s.emittedAt) ? +s.emittedAt : now();
    const row = {
      user_id: userId, item_id: String(s.itemId || s.symbol).slice(0, 40), symbol: String(s.symbol).toUpperCase().slice(0, 20), exchange: String(s.exchange || "").toUpperCase().slice(0, 16),
      market_kind: ["us", "eu", "fx", "crypto", "other"].includes(s.marketKind) ? s.marketKind : "us",
      profile: s.profile === "scalp" ? "scalp" : "day", origin: s.origin === "opportunity" ? "opportunity" : "analysis", side,
      entry: num("entry"), stop: num("stop"), target1: num("target1"), target2: num("target2"),
      valid_minutes: Math.max(1, Math.min(24 * 60, Math.round(Number(s.validMinutes) || 45))), stars: Math.max(0, Math.min(5, Math.round(Number(s.stars) || 0))),
      emitted_at: emittedAt, emitted_minute: Math.floor(emittedAt / 60000)
    };
    if (!/^[A-Z0-9.\-\/:_]{1,20}$/.test(row.symbol)) throw new Error("symbole invalide");
    const r = db().prepare(`INSERT OR IGNORE INTO signals (user_id,item_id,symbol,exchange,market_kind,profile,origin,side,entry,stop,target1,target2,valid_minutes,stars,emitted_at,emitted_minute)
      VALUES (@user_id,@item_id,@symbol,@exchange,@market_kind,@profile,@origin,@side,@entry,@stop,@target1,@target2,@valid_minutes,@stars,@emitted_at,@emitted_minute)`).run(row);
    return { recorded: r.changes > 0 };
  }

  /* Résout les signaux dont la validité est écoulée. Une série par symbole
     (cache serveur) ; bornée pour ne jamais peser sur une minute d'ouverture. */
  async function resolvePending(limit = 60) {
    const pending = db().prepare("SELECT * FROM signals WHERE outcome IS NULL AND emitted_at + valid_minutes * 60000 <= ? ORDER BY emitted_at ASC LIMIT ?").all(now(), limit);
    if (!pending.length || !market || !market.configured()) return { resolved: 0, pending: pending.length };
    const bySymbol = new Map();
    for (const p of pending) { const k = p.symbol + "|" + p.exchange; if (!bySymbol.has(k)) bySymbol.set(k, []); bySymbol.get(k).push(p); }
    let resolved = 0;
    for (const [k, list] of bySymbol) {
      const [symbol, exchange] = k.split("|");
      let candles;
      try {
        /* BACKEND_11 — TOUJOURS 15 min : une bougie d'une heure est plus large
           que la distance entre l'entrée et ses niveaux, elle rend le verdict
           impossible. On remonte simplement plus loin en nombre de bougies
           (1 200 max = plus de 30 séances US de 26 bougies). */
        const oldest = Math.min(...list.map(p => p.emitted_at));
        const spanMin = (now() - oldest) / 60000;
        const need = Math.min(1200, Math.max(120, Math.ceil(spanMin / 15) + 30));
        const data = await market.series({ symbol, interval: "15min", outputsize: need, exchange });
        candles = Array.isArray(data.values) ? data.values : [];
      } catch (e) { log.warn("signals: série indisponible pour la mesure", { symbol, reason: e.message }); continue; }
      const upd = db().prepare("UPDATE signals SET outcome = ?, ret_pct = ?, t2_reached = ?, resolved_at = ? WHERE id = ?");
      for (const sig of list) {
        const j = judge(sig, candles, now());
        if (j) { upd.run(j.outcome, j.ret_pct, j.t2_reached, now(), sig.id); resolved++; }
      }
    }
    return { resolved, pending: pending.length - resolved };
  }

  function stats({ days = 30, userId = null } = {}) {
    const since = now() - days * 86400000;
    const d = db();
    const rows = d.prepare("SELECT profile, stars, item_id, symbol, outcome, ret_pct, t2_reached FROM signals WHERE emitted_at >= ? AND outcome IS NOT NULL").all(since);
    const pendingCount = d.prepare("SELECT COUNT(*) AS n FROM signals WHERE emitted_at >= ? AND outcome IS NULL").get(since).n;
    const mine = userId ? d.prepare("SELECT COUNT(*) AS n FROM signals WHERE user_id = ? AND emitted_at >= ?").get(userId, since).n : null;
    const agg = all => {
      const undet = all.filter(r => r.outcome === "undetermined").length;
      const list = all.filter(r => r.outcome !== "undetermined");
      const n = list.length; if (!n) return { count: 0, undetermined: undet };
      const t1 = list.filter(r => r.outcome === "target1").length, st = list.filter(r => r.outcome === "stop").length, ex = n - t1 - st;
      const t2 = list.filter(r => r.t2_reached).length;
      const avg = list.reduce((s, r) => s + (r.ret_pct || 0), 0) / n;
      return { count: n, undetermined: undet, target1Pct: Math.round(t1 / n * 1000) / 10, stopPct: Math.round(st / n * 1000) / 10, expiredPct: Math.round(ex / n * 1000) / 10, target2Pct: Math.round(t2 / n * 1000) / 10, avgReturnPct: Math.round(avg * 100) / 100 };
    };
    const group = key => { const m = new Map(); for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return [...m.entries()].map(([k, l]) => ({ key: k, ...agg(l) })); };
    const overall = agg(rows);
    return {
      days, minSignals: MIN_SIGNALS_FOR_STATS, enough: overall.count >= MIN_SIGNALS_FOR_STATS, pending: pendingCount, mine,
      overall,
      byProfile: group(r => r.profile),
      byStars: group(r => String(r.stars)).sort((a, b) => a.key.localeCompare(b.key)),
      byInstrument: group(r => r.item_id).filter(x => x.count >= 5).sort((a, b) => b.count - a.count).slice(0, 12)
    };
  }

  /* BACKEND_11 — les verdicts rendus avant ce correctif ont été établis sur
     des bougies d'une heure : ils sont remis en attente pour être rejugés
     proprement en 15 min. Une seule fois, marquée en base. */
  function rejudgeLegacy() {
    const d = db();
    d.exec(`CREATE TABLE IF NOT EXISTS signals_meta (key TEXT PRIMARY KEY, value TEXT)`);
    const done = d.prepare("SELECT value FROM signals_meta WHERE key = 'rejudge_b11'").get();
    if (done) return { reset: 0, alreadyDone: true };
    const r = d.prepare("UPDATE signals SET outcome = NULL, ret_pct = NULL, t2_reached = 0, resolved_at = NULL WHERE outcome IS NOT NULL").run();
    d.prepare("INSERT OR REPLACE INTO signals_meta (key, value) VALUES ('rejudge_b11', ?)").run(String(now()));
    log.info && log.info("signals: verdicts remis en attente pour être rejugés en 15 min", { reset: r.changes });
    return { reset: r.changes, alreadyDone: false };
  }

  function schedule(intervalMs = 15 * 60000) {
    try { rejudgeLegacy(); } catch (e) { log.warn("signals: remise à zéro impossible", { reason: e.message }); }
    const t = setInterval(() => { resolvePending().catch(e => log.warn("signals: résolution en échec", { reason: e.message })); }, intervalMs);
    if (t.unref) t.unref();
    return t;
  }

  return { record, resolvePending, stats, schedule, rejudgeLegacy, judge, candleEpoch, MIN_SIGNALS_FOR_STATS };
}

module.exports = { createSignals, judge, candleEpoch, ensureSchema, MIN_SIGNALS_FOR_STATS };
