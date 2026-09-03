/* BACKEND_6 — données de marché servies par le SERVEUR (décision Simon 03/09).
   Une seule clé Twelve Data (plan Business Venture) posée sur le serveur ;
   les téléphones ne parlent plus qu'à cette route.

   Trois idées, chacune avec sa raison :
   1. CACHE PAR INSTRUMENT — la clé de cache est (symbole, intervalle,
      taille), jamais l'utilisateur. Mille personnes sur NVDA = un appel.
      La durée de vie suit l'intervalle : une bougie de 15 min ne change
      pas toutes les secondes.
   2. REGROUPEMENT DES DEMANDES EN VOL — deux cents demandes de NVDA dans
      la même seconde, cache vide : UN appel part, les autres attendent
      la même promesse. Sans ça, la première minute d'ouverture brûlerait
      le quota.
   3. QUOTAS DANS UN MAGASIN EXTERNE — le compteur par utilisateur passe
      par une interface (get/incr/day) implémentée aujourd'hui en SQLite,
      demain en Redis quand il y aura plusieurs instances. Le service ne
      sait pas où vivent les compteurs : c'est ce qui évite la réécriture.

   Ce que le service NE fait PAS : aucun calcul de signal, aucune
   transformation des bougies. Il renvoie la charge utile Twelve Data
   telle quelle, plus l'âge de la donnée et sa provenance (cache / live /
   stale), pour que l'app dise la vérité comme elle le fait déjà avec le
   bandeau « dernière bougie · il y a N min ». */
"use strict";

const TTL_MS = { "1min": 15000, "5min": 30000, "15min": 60000, "30min": 90000, "1h": 120000, "4h": 300000, "1day": 600000, "1week": 3600000, "1month": 3600000 };
const PRICE_TTL_MS = 20000;
const STALE_MAX_MS = 15 * 60000;   // au-delà, une copie périmée n'est plus servie
const CACHE_MAX_ENTRIES = 5000;    // ~catalogue × intervalles × tailles, avec de la marge

const DEFAULT_LIMITS = {
  /* Requêtes servies par jour (cache compris : c'est une mesure d'usage,
     pas de crédits) — et un plafond par minute pour protéger le serveur. */
  admin:      { perDay: Infinity, perMinute: 240 },
  subscribed: { perDay: 5000,     perMinute: 120 },
  trial:      { perDay: 5000,     perMinute: 120 },
  free:       { perDay: 200,      perMinute: 30 }
};

class MarketDataError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra || {}); }
}

function createMarketData({ apiKey, fetchImpl, now = () => Date.now(), quotaStore, limits = DEFAULT_LIMITS, logger } = {}) {
  const cache = new Map();     // key → { payload, fetchedAt, credits }
  const inFlight = new Map();  // key → Promise
  const stats = { live: 0, cacheHits: 0, coalesced: 0, stale: 0, errors: 0, creditsThisMinute: 0, minuteStart: 0 };
  const log = logger || { info() {}, warn() {} };

  function configured() { return Boolean(apiKey); }

  function touchMinute() {
    const m = Math.floor(now() / 60000);
    if (m !== stats.minuteStart) { stats.minuteStart = m; stats.creditsThisMinute = 0; }
  }

  function evictIfNeeded() {
    if (cache.size <= CACHE_MAX_ENTRIES) return;
    const oldest = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt).slice(0, Math.floor(CACHE_MAX_ENTRIES / 10));
    for (const [k] of oldest) cache.delete(k);
  }

  async function callTwelveData(url, credits) {
    const f = fetchImpl || globalThis.fetch;
    const res = await f(url, { headers: { "User-Agent": "YukiTraderPro-server" } });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    /* Twelve Data répond 200 avec {status:"error", code} pour les erreurs
       métier (symbole inconnu, plan, 429). On normalise. */
    if (!res.ok || (data && data.status === "error")) {
      const code = (data && data.code) || res.status;
      throw new MarketDataError(code === 429 ? 429 : (code === 404 ? 404 : 502), (data && data.message) || ("Twelve Data HTTP " + res.status), { apiCode: code });
    }
    touchMinute(); stats.creditsThisMinute += credits; stats.live++;
    return data;
  }

  /* Cœur : cache → en vol → appel. `ttl` dépend de l'intervalle. */
  async function getCached(key, ttlMs, credits, urlBuilder) {
    const t = now();
    const hit = cache.get(key);
    if (hit && t - hit.fetchedAt < ttlMs) { stats.cacheHits++; return { payload: hit.payload, fetchedAt: hit.fetchedAt, source: "cache" }; }
    if (inFlight.has(key)) { stats.coalesced++; return inFlight.get(key); }
    const p = (async () => {
      try {
        const payload = await callTwelveData(urlBuilder(), credits);
        const fetchedAt = now();
        cache.set(key, { payload, fetchedAt, credits }); evictIfNeeded();
        return { payload, fetchedAt, source: "live" };
      } catch (e) {
        stats.errors++;
        /* 429 ou panne amont : une copie récente vaut mieux qu'un écran vide,
           à condition de DIRE qu'elle est périmée. */
        if (hit && now() - hit.fetchedAt < STALE_MAX_MS) { stats.stale++; log.warn("market: copie périmée servie", { key, reason: e.message }); return { payload: hit.payload, fetchedAt: hit.fetchedAt, source: "stale", reason: e.message }; }
        throw e;
      } finally { inFlight.delete(key); }
    })();
    inFlight.set(key, p);
    return p;
  }

  const SYMBOL_RE = /^[A-Z0-9.\-\/:_]{1,20}$/i;
  function checkSymbol(symbol) { if (!SYMBOL_RE.test(String(symbol || ""))) throw new MarketDataError(400, "Symbole invalide."); return String(symbol).toUpperCase(); }

  async function series({ symbol, interval, outputsize }) {
    if (!configured()) throw new MarketDataError(503, "Données de marché non configurées sur le serveur.", { code: "not_configured" });
    const sym = checkSymbol(symbol);
    const itv = TTL_MS[interval] ? interval : null;
    if (!itv) throw new MarketDataError(400, "Intervalle non pris en charge.");
    const size = Math.max(30, Math.min(500, parseInt(outputsize, 10) || 120));
    const key = `series|${sym}|${itv}|${size}`;
    const r = await getCached(key, TTL_MS[itv], 1, () => "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(sym) + "&interval=" + itv + "&outputsize=" + size + "&order=asc&apikey=" + encodeURIComponent(apiKey));
    return { ...r.payload, meta_yuki: { fetchedAt: r.fetchedAt, ageMs: now() - r.fetchedAt, source: r.source, reason: r.reason || null } };
  }

  async function price({ symbol }) {
    if (!configured()) throw new MarketDataError(503, "Données de marché non configurées sur le serveur.", { code: "not_configured" });
    const sym = checkSymbol(symbol);
    const key = `price|${sym}`;
    const r = await getCached(key, PRICE_TTL_MS, 1, () => "https://api.twelvedata.com/price?symbol=" + encodeURIComponent(sym) + "&apikey=" + encodeURIComponent(apiKey));
    return { ...r.payload, meta_yuki: { fetchedAt: r.fetchedAt, ageMs: now() - r.fetchedAt, source: r.source, reason: r.reason || null } };
  }

  /* ---- quotas par utilisateur (magasin externe) ---- */
  function tierOf(access) {
    if (!access) return "free";
    if (access.reason === "admin") return "admin";
    if (access.reason === "subscribed") return "subscribed";
    if (access.reason === "trial") return "trial";
    return "free";
  }
  async function consume(userId, access) {
    if (!quotaStore) return { tier: tierOf(access), remainingDay: Infinity };
    const tier = tierOf(access), lim = limits[tier] || limits.free;
    const day = new Date(now()).toISOString().slice(0, 10), minute = Math.floor(now() / 60000);
    const c = await quotaStore.incr(userId, day, minute);
    if (c.minute > lim.perMinute) throw new MarketDataError(429, `Trop de demandes cette minute (${lim.perMinute}/min). Réessaie dans quelques secondes.`, { code: "quota_minute", tier });
    if (c.day > lim.perDay) throw new MarketDataError(429, tier === "free" ? `Quota d'essai du jour atteint (${lim.perDay} demandes). L'abonnement Fondateur inclut les données de marché.` : `Quota quotidien atteint (${lim.perDay} demandes).`, { code: "quota_day", tier });
    return { tier, remainingDay: lim.perDay === Infinity ? Infinity : lim.perDay - c.day, remainingMinute: lim.perMinute - c.minute };
  }

  function status() { touchMinute(); return { configured: configured(), cacheEntries: cache.size, inFlight: inFlight.size, ...stats }; }
  function _clear() { cache.clear(); inFlight.clear(); }

  return { series, price, consume, status, configured, tierOf, _clear, MarketDataError, TTL_MS, DEFAULT_LIMITS };
}

/* Magasin de quotas SQLite — même interface que la future version Redis :
   incr(userId, day, minute) → { day, minute } (compteurs après incrément). */
function sqliteQuotaStore(getDb) {
  let ready = false;
  function ensure() {
    if (ready) return; ready = true;
    getDb().exec(`CREATE TABLE IF NOT EXISTS market_quota (
      user_id TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
      minute INTEGER NOT NULL DEFAULT 0, minute_requests INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    )`);
  }
  return {
    async incr(userId, day, minute) {
      ensure();
      const db = getDb();
      const row = db.prepare("SELECT requests, minute, minute_requests FROM market_quota WHERE user_id = ? AND day = ?").get(userId, day);
      const requests = (row ? row.requests : 0) + 1;
      const minuteRequests = (row && row.minute === minute) ? row.minute_requests + 1 : 1;
      db.prepare(`INSERT INTO market_quota (user_id, day, requests, minute, minute_requests) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, day) DO UPDATE SET requests = excluded.requests, minute = excluded.minute, minute_requests = excluded.minute_requests`)
        .run(userId, day, requests, minute, minuteRequests);
      return { day: requests, minute: minuteRequests };
    }
  };
}

function memoryQuotaStore() {
  const m = new Map();
  return { async incr(userId, day, minute) { const k = userId + "|" + day; const row = m.get(k) || { requests: 0, minute: 0, minuteRequests: 0 }; row.requests++; row.minuteRequests = row.minute === minute ? row.minuteRequests + 1 : 1; row.minute = minute; m.set(k, row); return { day: row.requests, minute: row.minuteRequests }; } };
}

module.exports = { createMarketData, sqliteQuotaStore, memoryQuotaStore, MarketDataError, DEFAULT_LIMITS, TTL_MS };
