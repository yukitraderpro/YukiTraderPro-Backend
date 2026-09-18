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
/* BACKEND_15 — on compte des SITUATIONS, pas des signaux (constat Simon
   18/09 : 79 signaux dont des dizaines identiques, même actif, même sens,
   même séance, à quelques minutes d'écart — de quoi faire dire n'importe
   quoi à un pourcentage). Une situation = un actif + un sens + une séance ;
   ses signaux sont regroupés et comptent pour UN, avec le verdict majoritaire
   (un objectif atteint l'emporte sur un stop dans la même situation : c'est
   le premier signal de la situation qui aurait été suivi). */
const MIN_SIGNALS_FOR_STATS = 20; /* désormais : minimum de SITUATIONS */

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
    mirror_outcome TEXT,
    UNIQUE(user_id, symbol, profile, side, emitted_minute)
  )`);
  try { db.exec(`ALTER TABLE signals ADD COLUMN mirror_outcome TEXT`); } catch (_) {} /* base existante */
  try { db.exec(`ALTER TABLE signals ADD COLUMN measure_error TEXT`); } catch (_) {} /* BACKEND_13 : pourquoi un signal reste en attente */
  db.exec(`CREATE INDEX IF NOT EXISTS idx_signals_pending ON signals(outcome, emitted_at)`);
  /* BACKEND_12 — observations du suivi en direct : quand la position suivie
     touche un niveau, le téléphone le dit au serveur. C'est la vérité
     terrain contre laquelle la mesure a posteriori doit être vérifiée. */
  db.exec(`CREATE TABLE IF NOT EXISTS signal_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item_id TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
    entry REAL NOT NULL, observed TEXT NOT NULL, price REAL, opened_at INTEGER, observed_at INTEGER NOT NULL,
    UNIQUE(user_id, symbol, side, opened_at, observed)
  )`);
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
/* BACKEND_12 — le signal MIROIR : même entrée, mêmes distances, sens opposé.
   Si les miroirs touchent leur objectif alors que les signaux ne le touchent
   jamais, le moteur est à contresens sur ce marché ; si les deux échouent,
   c'est la géométrie qui est trop ambitieuse pour la volatilité du moment. */
function mirrorOf(sig) {
  const side = sig.side === "SELL" ? -1 : 1, e = sig.entry;
  return { ...sig, side: side > 0 ? "SELL" : "BUY", stop: e - (sig.stop - e), target1: e - (sig.target1 - e), target2: e - (sig.target2 - e) };
}

/* Séance d'un instant : le jour de bourse à New York (les marchés continus
   suivent la même découpe, ce qui suffit pour regrouper). */
function sessionKey(ms) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)); }
  catch (_) { return new Date(ms).toISOString().slice(0, 10); }
}
/* Un actif + un sens + une séance = une ligne. Verdict : objectif s'il a été
   atteint au moins une fois, sinon stop, sinon expiré ; indéterminé seulement
   si toute la situation l'est. Rendement et miroir : moyenne de la situation. */
function groupSituations(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = r.item_id + "|" + r.side + "|" + r.profile + "|" + sessionKey(r.emitted_at);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const rank = { target1: 3, stop: 2, expired: 1, undetermined: 0 };
  return [...by.values()].map(list => {
    const best = list.reduce((a, b) => (rank[b.outcome] || 0) > (rank[a.outcome] || 0) ? b : a);
    const withRet = list.filter(x => Number.isFinite(x.ret_pct));
    const mirrors = list.filter(x => x.mirror_outcome && x.mirror_outcome !== "undetermined");
    const mBest = mirrors.length ? mirrors.reduce((a, b) => (rank[b.mirror_outcome] || 0) > (rank[a.mirror_outcome] || 0) ? b : a).mirror_outcome : null;
    return {
      profile: best.profile, stars: best.stars, item_id: best.item_id, symbol: best.symbol,
      outcome: best.outcome, t2_reached: list.some(x => x.t2_reached) ? 1 : 0,
      ret_pct: withRet.length ? withRet.reduce((a, b) => a + b.ret_pct, 0) / withRet.length : null,
      mirror_outcome: mBest, signals: list.length
    };
  });
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
      } catch (e) {
        log.warn("signals: série indisponible pour la mesure", { symbol, reason: e.message });
        /* BACKEND_13 — la raison est écrite sur le signal : la vue admin la montre au lieu d'un « attente » muet. */
        const err = db().prepare("UPDATE signals SET measure_error = ? WHERE id = ?");
        for (const sig of list) err.run(String(e.message || e).slice(0, 160), sig.id);
        continue;
      }
      const upd = db().prepare("UPDATE signals SET outcome = ?, ret_pct = ?, t2_reached = ?, resolved_at = ?, mirror_outcome = ?, measure_error = NULL WHERE id = ?");
      const noteWait = db().prepare("UPDATE signals SET measure_error = ? WHERE id = ?");
      for (const sig of list) {
        const j = judge(sig, candles, now());
        if (j) { const m = judge(mirrorOf(sig), candles, now()); upd.run(j.outcome, j.ret_pct, j.t2_reached, now(), m ? m.outcome : null, sig.id); resolved++; }
        else noteWait.run("fenêtre non couverte par les bougies reçues (" + candles.length + " bougies)", sig.id);
      }
    }
    return { resolved, pending: pending.length - resolved };
  }

  function observe(userId, o) {
    const side = o.side === "SELL" ? "SELL" : "BUY", observed = ["target1", "target2", "stop"].includes(o.observed) ? o.observed : null;
    if (!observed) throw new Error("observation invalide");
    const symbol = String(o.symbol || "").toUpperCase().slice(0, 20); if (!/^[A-Z0-9.\-\/:_]{1,20}$/.test(symbol)) throw new Error("symbole invalide");
    const r = db().prepare(`INSERT OR IGNORE INTO signal_observations (user_id, item_id, symbol, side, entry, observed, price, opened_at, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, String(o.itemId || symbol).slice(0, 40), symbol, side, Number(o.entry) || 0, observed, Number.isFinite(+o.price) ? +o.price : null, Number.isFinite(+o.openedAt) ? +o.openedAt : null, now());
    return { recorded: r.changes > 0 };
  }

  /* Rapprochement : pour chaque observation « objectif 1 touché » du suivi,
     existe-t-il un signal mesuré du même actif, même sens, émis dans les 30
     minutes autour de l'ouverture, et qu'a-t-il conclu ? Un désaccord
     fréquent = la mesure est fausse, pas le moteur. */
  function reconcile(days = 30) {
    const since = now() - days * 86400000, d = db();
    const obs = d.prepare("SELECT * FROM signal_observations WHERE observed_at >= ? AND observed IN ('target1','target2','stop')").all(since);
    let matched = 0, agree = 0; const detail = [];
    for (const o of obs) {
      if (!o.opened_at) continue;
      const sig = d.prepare("SELECT outcome FROM signals WHERE symbol = ? AND side = ? AND ABS(emitted_at - ?) <= 1800000 AND outcome IS NOT NULL ORDER BY ABS(emitted_at - ?) ASC LIMIT 1").get(o.symbol, o.side, o.opened_at, o.opened_at);
      if (!sig) continue;
      matched++;
      const obsT = o.observed === "stop" ? "stop" : "target1";
      const ok = sig.outcome === obsT || (obsT === "target1" && sig.outcome === "target1");
      if (ok) agree++; else detail.push({ symbol: o.symbol, side: o.side, observed: o.observed, judged: sig.outcome });
    }
    return { observations: obs.length, matched, agree, disagreements: detail.slice(0, 20) };
  }

  function recent(limit = 60) {
    return db().prepare("SELECT id, user_id, item_id, symbol, profile, origin, side, entry, stop, target1, target2, valid_minutes, stars, emitted_at, outcome, ret_pct, mirror_outcome, measure_error FROM signals ORDER BY emitted_at DESC LIMIT ?").all(Math.max(1, Math.min(300, limit)));
  }

  function stats({ days = 30, userId = null } = {}) {
    const since = now() - days * 86400000;
    const d = db();
    const raw = d.prepare("SELECT profile, stars, item_id, symbol, side, outcome, ret_pct, t2_reached, mirror_outcome, emitted_at FROM signals WHERE emitted_at >= ? AND outcome IS NOT NULL ORDER BY emitted_at ASC").all(since);
    const rows = groupSituations(raw);
    const mirrorRows = rows.filter(r => r.mirror_outcome && r.mirror_outcome !== "undetermined");
    const mirror = mirrorRows.length ? { count: mirrorRows.length, target1Pct: Math.round(mirrorRows.filter(r => r.mirror_outcome === "target1").length / mirrorRows.length * 1000) / 10, stopPct: Math.round(mirrorRows.filter(r => r.mirror_outcome === "stop").length / mirrorRows.length * 1000) / 10 } : { count: 0 };
    const rec = reconcile(days);
    const pendingCount = d.prepare("SELECT COUNT(*) AS n FROM signals WHERE emitted_at >= ? AND outcome IS NULL").get(since).n;
    const rawCount = raw.length;
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
      rawSignals: rawCount, situations: rows.length,
      overall, mirror, reconciliation: rec,
      /* La carte publique ne s'affiche que si la mesure a été confrontée au
         suivi réel et lui donne raison : au moins 10 rapprochements et 80 %
         d'accord. Avant cela, seul l'administrateur la voit. */
      validated: rec.matched >= 10 && rec.agree / rec.matched >= 0.8,
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

  /* BACKEND_13 — les verdicts rendus avant le signal miroir n'en ont pas :
     on remet UNE fois en attente ceux dont le miroir manque, pour qu'ils
     soient rejugés avec (même série, même règle). */
  function rejudgeForMirror() {
    const d = db();
    d.exec(`CREATE TABLE IF NOT EXISTS signals_meta (key TEXT PRIMARY KEY, value TEXT)`);
    if (d.prepare("SELECT value FROM signals_meta WHERE key = 'rejudge_b13'").get()) return { reset: 0, alreadyDone: true };
    const r = d.prepare("UPDATE signals SET outcome = NULL, ret_pct = NULL, t2_reached = 0, resolved_at = NULL WHERE outcome IS NOT NULL AND mirror_outcome IS NULL").run();
    d.prepare("INSERT OR REPLACE INTO signals_meta (key, value) VALUES ('rejudge_b13', ?)").run(String(now()));
    return { reset: r.changes, alreadyDone: false };
  }

  function schedule(intervalMs = 15 * 60000) {
    try { rejudgeLegacy(); rejudgeForMirror(); } catch (e) { log.warn("signals: remise à zéro impossible", { reason: e.message }); }
    const t = setInterval(() => { resolvePending().catch(e => log.warn("signals: résolution en échec", { reason: e.message })); }, intervalMs);
    if (t.unref) t.unref();
    return t;
  }

  return { record, observe, reconcile, recent, resolvePending, stats, schedule, rejudgeLegacy, rejudgeForMirror, judge, mirrorOf, candleEpoch, MIN_SIGNALS_FOR_STATS };
}

module.exports = { createSignals, judge, mirrorOf, groupSituations, sessionKey, candleEpoch, ensureSchema, MIN_SIGNALS_FOR_STATS };
