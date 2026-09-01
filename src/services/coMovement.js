/* ==========================================================================
   « Ondes de choc » — co-mouvement mesuré entre une société et les actifs
   qui lui sont liés (ETF porteurs, pairs, chaîne fournisseurs/clients).
   --------------------------------------------------------------------------
   Doctrine : on ne devine pas, on mesure. La carte src/data/ondes-de-choc-
   relations.json ne fait que proposer des CANDIDATS ; ce module calcule
   chaque nuit, sur 60 séances de rendements quotidiens (séries 1day —
   formule Twelve Data gratuite), la corrélation et la part des séances
   dans le même sens. Aucune direction n'est jamais prédite.
   Fonctions pures + une fonction d'orchestration injectable (fetch, délai)
   pour être testées sans réseau.
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const db = require("../db");
const logger = require("../logger");

const RELATIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "ondes-de-choc-relations.json"), "utf8"));
const FENETRE = Number(RELATIONS.fenetre_jours || 60);

function linkedSymbols(soc) {
  return [...new Set([...(soc.etfs || []).map(e => e.symbol), ...(soc.pairs || []), ...(soc.chaine || [])])];
}
function allSymbols() {
  const s = new Set();
  for (const soc of RELATIONS.societes) { s.add(soc.symbol); linkedSymbols(soc).forEach(x => s.add(x)); }
  return [...s];
}

/* Rendements quotidiens sur des dates COMMUNES aux deux séries (les places
   n'ont pas les mêmes jours fériés). `a` et `b` : Map date -> clôture. */
function alignedReturns(a, b, fenetre = FENETRE) {
  const dates = [...a.keys()].filter(d => b.has(d)).sort();
  const ra = [], rb = [];
  for (let i = 1; i < dates.length; i++) {
    const pa = a.get(dates[i - 1]), pb = b.get(dates[i - 1]);
    if (pa > 0 && pb > 0) { ra.push(a.get(dates[i]) / pa - 1); rb.push(b.get(dates[i]) / pb - 1); }
  }
  return { ra: ra.slice(-fenetre), rb: rb.slice(-fenetre) };
}
function pearson(x, y) {
  const n = Math.min(x.length, y.length); if (n < 20) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
  if (!dx || !dy) return null;
  return num / Math.sqrt(dx * dy);
}
function agreement(x, y) {
  const n = Math.min(x.length, y.length); if (n < 20) return null;
  let same = 0;
  for (let i = 0; i < n; i++) if (Math.sign(x[i]) === Math.sign(y[i])) same++;
  return same / n;
}

async function fetchDailySeries(symbol, apiKey, fetchImpl) {
  const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(symbol) +
    "&interval=1day&outputsize=" + (FENETRE + 12) + "&apikey=" + encodeURIComponent(apiKey) + "&format=JSON";
  const r = await fetchImpl(url);
  const j = await r.json();
  if (!j || !Array.isArray(j.values)) throw new Error((j && j.message) || "réponse invalide");
  const m = new Map();
  for (const v of j.values) { const c = Number(v.close); if (Number.isFinite(c)) m.set(String(v.datetime).slice(0, 10), c); }
  return m;
}

/* Calcul complet : une passe séquentielle sur l'union des symboles (respect du
   rythme d'une clé gratuite : 8 appels/min → delayMs ≈ 8000), puis upsert. */
async function computeAll({ apiKey, fetchImpl = globalThis.fetch, delayMs = 8000, now = Date.now(), sleep } = {}) {
  if (!apiKey) throw new Error("clé de données absente");
  const wait = sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const series = new Map(); const failed = [];
  const symbols = allSymbols();
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    try { series.set(s, await fetchDailySeries(s, apiKey, fetchImpl)); }
    catch (e) { failed.push({ symbol: s, error: e.message }); }
    if (i < symbols.length - 1 && delayMs > 0) await wait(delayMs);
  }
  const conn = db.get();
  const up = conn.prepare(`INSERT INTO co_movement (mover, linked, corr, agreement, n, computed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(mover, linked) DO UPDATE SET corr = excluded.corr, agreement = excluded.agreement, n = excluded.n, computed_at = excluded.computed_at`);
  let rows = 0;
  for (const soc of RELATIONS.societes) {
    const a = series.get(soc.symbol); if (!a) continue;
    for (const l of linkedSymbols(soc)) {
      const b = series.get(l); if (!b) continue;
      const { ra, rb } = alignedReturns(a, b);
      const c = pearson(ra, rb), g = agreement(ra, rb);
      if (c === null || g === null) continue;
      up.run(soc.symbol, l, c, g, Math.min(ra.length, rb.length), now); rows++;
    }
  }
  logger.info("[ondes] co-mouvement recalculé", { symboles: symbols.length, echecs: failed.length, lignes: rows });
  return { symbols: symbols.length, failed, rows };
}

/* Lecture pour l'application : la société comme émettrice, et comme actif lié. */
function linksFor(symbol) {
  const sym = String(symbol || "").toUpperCase();
  const conn = db.get();
  const seuil = Number(RELATIONS.seuil_affichage_correlation || 0.55);
  const byMover = conn.prepare("SELECT linked, corr, agreement, n, computed_at FROM co_movement WHERE mover = ?").all(sym);
  const byLinked = conn.prepare("SELECT mover, corr, agreement, n, computed_at FROM co_movement WHERE linked = ?").all(sym);
  const soc = RELATIONS.societes.find(s => s.symbol === sym) || null;
  const nomDe = s => { const x = RELATIONS.societes.find(z => z.symbol === s); return x ? x.nom : s; };
  const asMover = soc ? {
    nom: soc.nom, secteur: soc.secteur,
    candidats: linkedSymbols(soc),
    mesures: byMover.filter(r => r.corr >= seuil).sort((a, b) => b.corr - a.corr).map(r => ({ symbol: r.linked, corr: +r.corr.toFixed(2), agreement: +r.agreement.toFixed(2), n: r.n, computedAt: r.computed_at }))
  } : null;
  const asLinked = RELATIONS.societes.filter(s => linkedSymbols(s).includes(sym)).map(s => {
    const m = byLinked.find(r => r.mover === s.symbol);
    return { mover: s.symbol, nom: s.nom, corr: m ? +m.corr.toFixed(2) : null, agreement: m ? +m.agreement.toFixed(2) : null, n: m ? m.n : null, computedAt: m ? m.computed_at : null };
  }).filter(x => x.corr === null || x.corr >= seuil).sort((a, b) => (b.corr || 0) - (a.corr || 0));
  return { symbol: sym, seuil, fenetre: FENETRE, asMover, asLinked, version: RELATIONS.version, nomDe: undefined };
}

module.exports = { RELATIONS, FENETRE, linkedSymbols, allSymbols, alignedReturns, pearson, agreement, fetchDailySeries, computeAll, linksFor };
