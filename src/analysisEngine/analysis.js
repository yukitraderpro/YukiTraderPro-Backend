/* ==========================================================================
   Yuki Trader Pro — Moteur d'analyse technique (analysis.js)
   --------------------------------------------------------------------------
   Module séparé de app.js (architecture modulaire demandée par le cahier
   des charges). Contient uniquement des fonctions pures de calcul
   d'indicateurs + les fonctions de confluence / filtre anti-faux-signaux.
   Ce fichier ne touche jamais au DOM : il peut être repris tel quel côté
   serveur (Node) le jour où l'analyse sera déplacée côté backend, comme le
   demande la section « Architecture » du cahier des charges.
   ========================================================================== */

/* ---- Séries EMA (nécessaire pour MACD) ---------------------------------- */
function emaSeries(a, n) {
  if (!a.length) return [];
  const k = 2 / (n + 1);
  const out = [a[0]];
  for (let i = 1; i < a.length; i++) out.push(a[i] * k + out[i - 1] * (1 - k));
  return out;
}

/* ---- MACD (12,26,9) ------------------------------------------------------ */
function macd(closes) {
  if (closes.length < 35) return null;
  const eFast = emaSeries(closes, 12), eSlow = emaSeries(closes, 26);
  const len = Math.min(eFast.length, eSlow.length);
  const macdLine = [];
  for (let i = 0; i < len; i++) macdLine.push(eFast[eFast.length - len + i] - eSlow[eSlow.length - len + i]);
  const signalLine = emaSeries(macdLine, 9);
  const hist = macdLine.at(-1) - signalLine.at(-1);
  const prevHist = macdLine.length > 1 && signalLine.length > 1 ? macdLine.at(-2) - signalLine.at(-2) : hist;
  return { macd: macdLine.at(-1), signal: signalLine.at(-1), hist, rising: hist > prevHist };
}

/* ---- Bandes de Bollinger (20,2) ------------------------------------------ */
function bollinger(closes, n = 20, k = 2) {
  if (closes.length < n) return null;
  const slice = closes.slice(-n);
  const mid = slice.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(slice.reduce((s, x) => s + (x - mid) ** 2, 0) / n);
  const upper = mid + k * sd, lower = mid - k * sd, price = closes.at(-1);
  return { mid, upper, lower, percentB: (price - lower) / Math.max(1e-9, upper - lower), bandwidth: (upper - lower) / mid * 100 };
}

/* ---- ADX / +DI / -DI (14) — force de tendance ---------------------------- */
function adxIndicator(values, n = 14) {
  if (values.length < n * 2 + 1) return null;
  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < values.length; i++) {
    const up = values[i].high - values[i - 1].high, down = values[i - 1].low - values[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(values[i].high - values[i].low, Math.abs(values[i].high - values[i - 1].close), Math.abs(values[i].low - values[i - 1].close)));
  }
  const smooth = arr => { let s = arr.slice(0, n).reduce((a, b) => a + b, 0); const out = [s]; for (let i = n; i < arr.length; i++) { s = s - s / n + arr[i]; out.push(s); } return out; };
  const trS = smooth(tr), plusS = smooth(plusDM), minusS = smooth(minusDM);
  const plusDI = plusS.map((v, i) => 100 * v / Math.max(1e-9, trS[i]));
  const minusDI = minusS.map((v, i) => 100 * v / Math.max(1e-9, trS[i]));
  const dx = plusDI.map((v, i) => 100 * Math.abs(v - minusDI[i]) / Math.max(1e-9, v + minusDI[i]));
  if (dx.length < n) return null;
  let adxVal = dx.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < dx.length; i++) adxVal = (adxVal * (n - 1) + dx[i]) / n;
  return { adx: adxVal, plusDI: plusDI.at(-1), minusDI: minusDI.at(-1) };
}

/* ---- SuperTrend (10, x3) — approximation robuste sur ATR simple --------- */
function superTrendIndicator(values, period = 10, mult = 3) {
  if (values.length < period + 5) return null;
  const tr = [];
  for (let i = 1; i < values.length; i++) tr.push(Math.max(values[i].high - values[i].low, Math.abs(values[i].high - values[i - 1].close), Math.abs(values[i].low - values[i - 1].close)));
  let finalUpper = null, finalLower = null, dir = 1;
  for (let i = period; i < values.length; i++) {
    const atrV = tr.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
    const hl2 = (values[i].high + values[i].low) / 2;
    const basicUpper = hl2 + mult * atrV, basicLower = hl2 - mult * atrV;
    finalUpper = finalUpper === null ? basicUpper : (values[i - 1].close <= finalUpper ? Math.min(basicUpper, finalUpper) : basicUpper);
    finalLower = finalLower === null ? basicLower : (values[i - 1].close >= finalLower ? Math.max(basicLower, finalLower) : basicLower);
    if (values[i].close > finalUpper) dir = 1; else if (values[i].close < finalLower) dir = -1;
  }
  return { direction: dir, level: dir === 1 ? finalLower : finalUpper };
}

/* ---- Ichimoku (9,26,52) — position du prix par rapport au nuage --------- */
function ichimokuIndicator(values) {
  if (values.length < 52) return null;
  const highs = values.map(v => v.high), lows = values.map(v => v.low);
  const mid = n => (Math.max(...highs.slice(-n)) + Math.min(...lows.slice(-n))) / 2;
  const tenkan = mid(9), kijun = mid(26), senkouA = (tenkan + kijun) / 2, senkouB = mid(52);
  const price = values.at(-1).close, top = Math.max(senkouA, senkouB), bottom = Math.min(senkouA, senkouB);
  return { tenkan, kijun, senkouA, senkouB, aboveCloud: price > top, belowCloud: price < bottom, inCloud: price >= bottom && price <= top };
}

/* ---- Supports / résistances via points pivots (swing highs/lows) -------- */
function supportResistance(values, lookback = 60) {
  const slice = values.slice(-lookback);
  const highs = [], lows = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    if (c.high > slice[i - 1].high && c.high > slice[i - 2].high && c.high > slice[i + 1].high && c.high > slice[i + 2].high) highs.push(c.high);
    if (c.low < slice[i - 1].low && c.low < slice[i - 2].low && c.low < slice[i + 1].low && c.low < slice[i + 2].low) lows.push(c.low);
  }
  const price = values.at(-1).close;
  const resistance = highs.filter(h => h > price).sort((a, b) => a - b)[0] || null;
  const support = lows.filter(l => l < price).sort((a, b) => b - a)[0] || null;
  return { resistance, support };
}

/* ---- Confirmation par le volume (si fourni par le flux de données) ------ */
function volumeConfirm(values) {
  const vols = values.map(v => v.volume).filter(v => Number.isFinite(v) && v > 0);
  if (vols.length < 20) return null;
  const avg = vols.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
  const last = vols.at(-1);
  return { ratio: avg > 0 ? last / avg : 1, rising: last > avg * 1.15, falling: last < avg * 0.6 };
}

/* ---- VWAP glissant (Volume Weighted Average Price) ----------------------
   Vrai VWAP « de session » impossible sans calendrier d'ouverture/fermeture
   par marché (actions US vs forex 24h vs crypto 24/7) — voir le fichier des
   difficultés. On calcule ici un VWAP glissant sur les N dernières bougies,
   ce qui reste un repère institutionnel valide (prix moyen pondéré par le
   volume récent) même si ce n'est pas un VWAP ancré à l'ouverture. */
function vwapIndicator(values, n = 20) {
  const slice = values.slice(-n).filter(v => Number.isFinite(v.volume) && v.volume > 0);
  if (slice.length < Math.min(10, n)) return null;
  let pv = 0, vSum = 0;
  for (const c of slice) { const tp = (c.high + c.low + c.close) / 3; pv += tp * c.volume; vSum += c.volume; }
  if (vSum <= 0) return null;
  const vwap = pv / vSum, price = values.at(-1).close;
  return { vwap, aboveVwap: price > vwap, distPct: (price - vwap) / vwap * 100 };
}

/* ---- Cassure (breakout) / retour (pullback) sur canal récent ------------ */
function breakoutPullback(values, lookback = 20) {
  if (values.length < lookback + 5) return null;
  const prior = values.slice(-lookback - 5, -5);
  const channelHigh = Math.max(...prior.map(v => v.high)), channelLow = Math.min(...prior.map(v => v.low));
  const recent = values.slice(-5), price = values.at(-1).close;
  const brokeUp = recent.some(c => c.close > channelHigh), brokeDown = recent.some(c => c.close < channelLow);
  if (brokeUp && price >= channelHigh * 0.997 && price <= channelHigh * 1.03) return { type: price > channelHigh ? "breakout" : "pullback", direction: 1, level: channelHigh };
  if (brokeDown && price <= channelLow * 1.003 && price >= channelLow * 0.97) return { type: price < channelLow ? "breakout" : "pullback", direction: -1, level: channelLow };
  return null;
}

/* ---- Order Blocks (approximation) ----------------------------------------
   Simplification pédagogique du concept « Smart Money » : dernière bougie
   baissière avant un mouvement haussier impulsif (bloc de demande) ou
   dernière bougie haussière avant un mouvement baissier impulsif (bloc
   d'offre), et vérifie si le prix revient tester cette zone. Une vraie
   lecture SMC utilise en plus le carnet d'ordres / la profondeur de marché,
   indisponibles via un flux OHLCV grand public — voir le fichier des
   difficultés. */
function detectOrderBlocks(values, lookback = 40) {
  if (values.length < lookback + 4) return null;
  const slice = values.slice(-lookback);
  const price = values.at(-1).close;
  let demand = null, supply = null;
  for (let i = slice.length - 4; i >= 1; i--) {
    const c = slice[i], next3 = slice.slice(i + 1, i + 4);
    if (!next3.length) continue;
    const impulseUp = (next3.at(-1).close - c.close) / c.close > 0.012;
    const impulseDown = (c.close - next3.at(-1).close) / c.close > 0.012;
    if (!demand && c.close < c.open && impulseUp) demand = { low: c.low, high: c.high };
    if (!supply && c.close > c.open && impulseDown) supply = { low: c.low, high: c.high };
    if (demand && supply) break;
  }
  const retestingDemand = demand && price <= demand.high * 1.002 && price >= demand.low * 0.985;
  const retestingSupply = supply && price >= supply.low * 0.998 && price <= supply.high * 1.015;
  return { demand, supply, retestingDemand, retestingSupply };
}

/* ---- Fair Value Gaps (déséquilibres 3 bougies) --------------------------- */
function detectFVG(values, lookback = 30) {
  if (values.length < lookback + 3) return null;
  const slice = values.slice(-lookback), price = values.at(-1).close;
  let bullish = null, bearish = null;
  for (let i = slice.length - 1; i >= 2; i--) {
    const c1 = slice[i - 2], c3 = slice[i];
    if (!bullish && c1.high < c3.low) bullish = { bottom: c1.high, top: c3.low };
    if (!bearish && c1.low > c3.high) bearish = { bottom: c3.high, top: c1.low };
    if (bullish && bearish) break;
  }
  const inBullish = bullish && price >= bullish.bottom * 0.998 && price <= bullish.top * 1.002;
  const inBearish = bearish && price >= bearish.bottom * 0.998 && price <= bearish.top * 1.002;
  return { bullish, bearish, inBullish, inBearish };
}

/* ---- Liquidité : plus hauts/plus bas égaux + balayage (sweep) ----------- */
function detectLiquidity(values, lookback = 40, tol = 0.0015) {
  if (values.length < lookback + 3) return null;
  const slice = values.slice(-lookback);
  const highs = slice.map(v => v.high), lows = slice.map(v => v.low);
  const eqHighs = highs.filter((h, i) => highs.some((h2, j) => j !== i && Math.abs(h2 - h) / h < tol)).length >= 2;
  const eqLows = lows.filter((l, i) => lows.some((l2, j) => j !== i && Math.abs(l2 - l) / l < tol)).length >= 2;
  const last = values.at(-1), prevSwingHigh = Math.max(...slice.slice(0, -1).map(v => v.high));
  const prevSwingLow = Math.min(...slice.slice(0, -1).map(v => v.low));
  const sweepHigh = last.high > prevSwingHigh && last.close < prevSwingHigh;
  const sweepLow = last.low < prevSwingLow && last.close > prevSwingLow;
  return { eqHighs, eqLows, sweepHigh, sweepLow };
}

/* ---- Structure de marché (BOS / CHoCH) via swings ------------------------ */
function detectMarketStructure(values, lookback = 60) {
  const slice = values.slice(-lookback);
  const swings = [];
  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    if (c.high > slice[i - 1].high && c.high > slice[i - 2].high && c.high > slice[i + 1].high && c.high > slice[i + 2].high) swings.push({ type: "H", price: c.high, i });
    if (c.low < slice[i - 1].low && c.low < slice[i - 2].low && c.low < slice[i + 1].low && c.low < slice[i + 2].low) swings.push({ type: "L", price: c.low, i });
  }
  swings.sort((a, b) => a.i - b.i);
  const highs = swings.filter(s => s.type === "H"), lows = swings.filter(s => s.type === "L");
  if (highs.length < 2 || lows.length < 2) return null;
  const hh = highs.at(-1).price > highs.at(-2).price, hl = lows.at(-1).price > lows.at(-2).price;
  const lh = highs.at(-1).price < highs.at(-2).price, ll = lows.at(-1).price < lows.at(-2).price;
  const price = values.at(-1).close;
  let structure = "indéterminée", bos = false, choch = false;
  if (hh && hl) { structure = "haussière"; if (price > highs.at(-1).price) bos = true; }
  else if (lh && ll) { structure = "baissière"; if (price < lows.at(-1).price) bos = true; }
  else if (hh && ll) { structure = "en transition (CHoCH potentiel)"; choch = true; }
  else if (lh && hl) { structure = "en transition (CHoCH potentiel)"; choch = true; }
  return { structure, bos, choch };
}

/* ---- Force relative & corrélation vs un actif de référence --------------- */
function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : null;
}
function relativeStrength(closesA, closesB, lookback = 20) {
  const n = Math.min(lookback, closesA.length - 1, closesB.length - 1);
  if (n < 5) return null;
  const perfA = (closesA.at(-1) / closesA.at(-1 - n) - 1) * 100;
  const perfB = (closesB.at(-1) / closesB.at(-1 - n) - 1) * 100;
  return { perfA, perfB, diff: perfA - perfB, outperforming: perfA > perfB };
}
/* Appelé séparément depuis app.js (analyse manuelle uniquement, pour ne pas
   doubler la consommation de quota API sur les scans de listes — même
   logique que la confirmation multi-unités de temps déjà en place). */
function applyCorrelationRS(a, values, benchValues, benchLabel) {
  if (!benchValues || benchValues.length < 15) return a;
  const closesA = values.map(v => v.close), closesB = benchValues.map(v => v.close);
  const retA = [], retB = [];
  const n = Math.min(closesA.length, closesB.length);
  for (let i = 1; i < n; i++) { retA.push(closesA[closesA.length - n + i] / closesA[closesA.length - n + i - 1] - 1); retB.push(closesB[closesB.length - n + i] / closesB[closesB.length - n + i - 1] - 1); }
  const corr = pearsonCorrelation(retA, retB);
  const rs = relativeStrength(closesA, closesB, 20);
  if (corr !== null) a.reasons.push(`Corrélation avec ${benchLabel} : ${corr.toFixed(2)}`);
  if (rs) {
    if (rs.outperforming && rs.diff > 1) { a.confidence = Math.min(97, a.confidence + 4); a.reasons.push(`Force relative supérieure à ${benchLabel} (+${rs.diff.toFixed(1)} pts)`); }
    else if (!rs.outperforming && rs.diff < -1) { a.confidence = Math.max(30, a.confidence - 4); a.reasons.push(`Force relative inférieure à ${benchLabel} (${rs.diff.toFixed(1)} pts)`); }
  }
  a.correlation = corr; a.relativeStrength = rs;
  a.quality = gradeQuality(a.confidence, a.rr, a.strongTrend);
  return a;
}

/* ==========================================================================
   Confluence multi-indicateurs
   --------------------------------------------------------------------------
   Combine tous les indicateurs ci-dessus en un score, un nombre de votes
   d'accord/désaccord (pour détecter les faux signaux) et un ensemble de
   raisons lisibles par l'utilisateur — sans jamais exposer les indicateurs
   bruts, conformément à la philosophie du cahier des charges.
   ========================================================================== */
/* ---- Pondération dynamique des indicateurs -------------------------------
   Chaque indicateur "vote" avec une magnitude fixe (le sens et la force
   qu'il aurait dans un marché neutre) MULTIPLIÉE par un poids adaptatif
   compris entre 0.5 et 1.6, stocké dans `weights[name]` (défaut 1). Ce poids
   n'est jamais inventé : il est ajusté uniquement par `updateIndicatorWeights`
   ci-dessous, à partir du résultat réel (gagnant/perdant) des signaux passés
   où cet indicateur a voté dans le même sens que le signal pris. C'est la
   réponse concrète à l'exigence « pondération dynamique » du cahier des
   charges, sans jamais fabriquer de statistique non mesurée. */
const WEIGHT_MIN = 0.5, WEIGHT_MAX = 1.6, WEIGHT_STEP = 0.03;
function clampWeight(w) { return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, w)); }
const INDICATOR_NAMES = [
  "trend_court", "trend_long", "rsi", "momentum_court", "momentum_moyen",
  "macd", "bollinger", "adx", "supertrend", "ichimoku", "volume",
  "support_resistance", "vwap", "breakout_pullback", "order_blocks",
  "fvg", "liquidity", "market_structure"
];
function defaultIndicatorWeights() {
  const w = {}; INDICATOR_NAMES.forEach(n => w[n] = 1); return w;
}

function buildConfluence(values, baseScore, baseReasons, baseVotes, weights) {
  weights = weights || {};
  const closes = values.map(v => v.close), price = closes.at(-1);
  let score = baseScore, agree = 0, disagree = 0;
  const reasons = [...baseReasons];
  const votes = [...(baseVotes || [])];
  let available = 0, total = 0;
  const w = name => weights[name] === undefined ? 1 : weights[name];
  const vote = (v, label, name) => {
    const wv = v * (name ? w(name) : 1);
    if (v > 0) agree++; else if (v < 0) disagree++;
    if (label) reasons.push(label);
    if (name) votes.push({ name, dir: v > 0 ? 1 : v < 0 ? -1 : 0, magnitude: Math.abs(v), label: label || null });
    score += wv;
  };

  total++; const m = macd(closes);
  if (m) { available++;
    if (m.hist > 0 && m.rising) vote(1, "MACD haussier", "macd");
    else if (m.hist < 0 && !m.rising) vote(-1, "MACD baissier", "macd");
    else vote(0, null, "macd");
  }

  total++; const bb = bollinger(closes);
  if (bb) { available++;
    if (bb.percentB > 0.97) vote(-0.4, "Prix proche de la bande de Bollinger haute (surextension)", "bollinger");
    else if (bb.percentB < 0.03) vote(0.4, "Prix proche de la bande de Bollinger basse (surextension)", "bollinger");
    else vote(0, null, "bollinger");
  }

  total++; const adxRes = adxIndicator(values);
  let strongTrend = false;
  if (adxRes) { available++;
    strongTrend = adxRes.adx >= 25;
    if (adxRes.adx < 18) { score *= 0.75; reasons.push("Tendance faible (ADX < 18) — prudence"); }
    else if (strongTrend) { vote(adxRes.plusDI > adxRes.minusDI ? 0.6 : -0.6, "Tendance confirmée (ADX ≥ 25)", "adx"); }
  }

  total++; const st = superTrendIndicator(values);
  if (st) { available++; vote(st.direction > 0 ? 0.8 : -0.8, st.direction > 0 ? "SuperTrend haussier" : "SuperTrend baissier", "supertrend"); }

  total++; const ich = ichimokuIndicator(values);
  if (ich) { available++;
    if (ich.aboveCloud) vote(0.6, "Prix au-dessus du nuage Ichimoku", "ichimoku");
    else if (ich.belowCloud) vote(-0.6, "Prix sous le nuage Ichimoku", "ichimoku");
    else { vote(0, null, "ichimoku"); reasons.push("Prix dans le nuage Ichimoku — signal moins fiable"); }
  }

  total++; const vol = volumeConfirm(values);
  if (vol) { available++;
    if (vol.rising) vote(score >= 0 ? 0.4 : -0.4, "Volume en hausse (confirmation)", "volume");
    else if (vol.falling) { reasons.push("Volume faible — signal à confirmer"); score *= 0.9; }
  }

  total++; const sr = supportResistance(values);
  if (sr.resistance || sr.support) available++;
  if (sr.resistance && (sr.resistance - price) / price < 0.003) { vote(-0.6, "Résistance proche", "support_resistance"); }
  if (sr.support && (price - sr.support) / price < 0.003) { vote(0.6, "Support proche", "support_resistance"); }

  total++; const vw = vwapIndicator(values);
  if (vw) { available++;
    if (vw.aboveVwap && vw.distPct < 2) vote(0.3, "Prix au-dessus du VWAP glissant", "vwap");
    else if (!vw.aboveVwap && vw.distPct > -2) vote(-0.3, "Prix sous le VWAP glissant", "vwap");
    else vote(0, null, "vwap");
  }

  total++; const bp = breakoutPullback(values);
  if (bp) { available++;
    if (bp.type === "breakout") vote(bp.direction * 0.5, bp.direction > 0 ? "Cassure haussière de canal" : "Cassure baissière de canal", "breakout_pullback");
    else vote(bp.direction * 0.4, bp.direction > 0 ? "Pullback sur cassure haussière" : "Pullback sur cassure baissière", "breakout_pullback");
  }

  total++; const ob = detectOrderBlocks(values);
  if (ob && (ob.demand || ob.supply)) { available++;
    if (ob.retestingDemand) vote(0.4, "Retest d'un Order Block de demande", "order_blocks");
    if (ob.retestingSupply) vote(-0.4, "Retest d'un Order Block d'offre", "order_blocks");
  }

  total++; const fvg = detectFVG(values);
  if (fvg && (fvg.bullish || fvg.bearish)) { available++;
    if (fvg.inBullish) vote(0.3, "Prix dans un Fair Value Gap haussier", "fvg");
    if (fvg.inBearish) vote(-0.3, "Prix dans un Fair Value Gap baissier", "fvg");
  }

  total++; const liq = detectLiquidity(values);
  if (liq) { available++;
    if (liq.sweepLow) vote(0.5, "Balayage de liquidité sous un plus bas (Smart Money)", "liquidity");
    if (liq.sweepHigh) vote(-0.5, "Balayage de liquidité au-dessus d'un plus haut (Smart Money)", "liquidity");
    if (liq.eqHighs) reasons.push("Plus hauts égaux détectés — liquidité en attente au-dessus");
    if (liq.eqLows) reasons.push("Plus bas égaux détectés — liquidité en attente en dessous");
  }

  total++; const ms = detectMarketStructure(values);
  if (ms) { available++;
    if (ms.structure === "haussière") vote(ms.bos ? 0.6 : 0.3, ms.bos ? "Break of Structure haussier (Smart Money Concepts)" : "Structure de marché haussière", "market_structure");
    else if (ms.structure === "baissière") vote(ms.bos ? -0.6 : -0.3, ms.bos ? "Break of Structure baissier (Smart Money Concepts)" : "Structure de marché baissière", "market_structure");
    else if (ms.choch) { vote(0, null, "market_structure"); reasons.push("Changement de caractère possible (CHoCH) — structure en transition"); }
  }

  const falseSignalRisk = disagree >= 3 && agree <= disagree;
  const dataCompleteness = total > 0 ? available / total : 0;
  return { score, reasons, strongTrend, falseSignalRisk, agree, disagree, votes, dataCompleteness, sr };
}

/* ---- Contrainte « ne jamais inventer une justification » -----------------
   Si trop peu d'indicateurs ont pu être calculés (historique court, données
   manquantes), le moteur ne doit pas afficher un pourcentage de confiance
   qui donnerait une fausse impression de certitude. On expose un indicateur
   binaire, utilisé par l'appelant pour remplacer l'affichage numérique par
   « Confiance insuffisante », conformément au cahier des charges. */
function isDataInsufficient(values, dataCompleteness) {
  return values.length < 90 || dataCompleteness < 0.45;
}

/* ---- Niveau de risque (Faible / Modéré / Élevé) --------------------------
   Combine la volatilité récente, le ratio risque/gain et la présence de
   signaux contradictoires — trois facteurs déjà calculés ailleurs dans le
   moteur, exposés ici sous une forme lisible par l'utilisateur. */
function riskLevel(vol, rr, falseSignalRisk) {
  if (falseSignalRisk || vol > 4 || rr < 1.3) return "Élevé";
  if (vol > 2 || rr < 1.8) return "Modéré";
  return "Faible";
}

/* ---- Grade de qualité étendu (A+ à D) ------------------------------------ */
function gradeQuality(confidence, rr, strongTrend) {
  if (confidence >= 90 && rr >= 2.2 && strongTrend) return "A+";
  if (confidence >= 85 && rr >= 2) return "A";
  if (confidence >= 75 && rr >= 1.5) return "B";
  if (confidence >= 65) return "C";
  return "D";
}

/* ==========================================================================
   Scénarios haussier / baissier / neutre
   --------------------------------------------------------------------------
   Le cahier des charges demande une "analyse des scénarios
   haussier/baissier/neutre", pas seulement un signal unique. On dérive les
   trois scénarios directement de la même liste de votes qui a produit le
   score de confluence (aucune donnée nouvelle inventée) : la probabilité de
   chaque scénario est la part de la masse totale des votes qui va dans ce
   sens, avec un plancher neutre qui grandit avec le nombre de signaux
   contradictoires (falseSignalRisk). Chaque scénario embarque ses propres
   raisons (sous-ensemble tracé des raisons globales) et un niveau
   d'invalidation/déclenchement basé sur les niveaux déjà calculés
   (support/résistance), jamais un chiffre arbitraire. */
function computeScenarios(votes, sr, price, falseSignalRisk) {
  let bullSum = 0, bearSum = 0;
  for (const v of votes || []) {
    const mag = (v.magnitude || 0) * (v.weight || 1);
    if (v.dir > 0) bullSum += mag; else if (v.dir < 0) bearSum += mag;
  }
  const neutralBase = falseSignalRisk ? 2.2 : 0.9;
  const total = bullSum + bearSum + neutralBase;
  const bullPct = total > 0 ? Math.round((bullSum / total) * 100) : 33;
  const bearPct = total > 0 ? Math.round((bearSum / total) * 100) : 33;
  const neutralPct = Math.max(0, 100 - bullPct - bearPct);

  const bullReasons = (votes || []).filter(v => v.dir > 0 && v.label).map(v => v.label).slice(0, 4);
  const bearReasons = (votes || []).filter(v => v.dir < 0 && v.label).map(v => v.label).slice(0, 4);

  return {
    bullish: {
      probability: bullPct,
      reasons: bullReasons,
      trigger: sr && sr.resistance ? `Confirmation si le prix clôture durablement au-dessus de ${sr.resistance.toFixed(2)}` : "Confirmation si la pression acheteuse se maintient sur les prochaines bougies"
    },
    bearish: {
      probability: bearPct,
      reasons: bearReasons,
      trigger: sr && sr.support ? `Confirmation si le prix clôture durablement sous ${sr.support.toFixed(2)}` : "Confirmation si la pression vendeuse se maintient sur les prochaines bougies"
    },
    neutral: {
      probability: neutralPct,
      reasons: falseSignalRisk ? ["Trop de signaux contradictoires pour trancher"] : ["Absence de confluence suffisante dans un sens ou l'autre"]
    }
  };
}

/* ==========================================================================
   Historique des performances des signaux + apprentissage des poids
   --------------------------------------------------------------------------
   Ces fonctions restent pures (pas de fetch, pas de stockage) : l'appelant
   (app.js) leur fournit le prix d'entrée et le prix constaté plus tard,
   déjà récupéré via une analyse ultérieure du même instrument — aucune
   requête API supplémentaire n'est déclenchée par ce module, pour respecter
   la contrainte de quota déjà documentée ailleurs dans le projet. */
function evaluateSignal(signal, entryPrice, laterPrice, minMovePct = 0.3) {
  if (signal === "ATTENDRE" || !Number.isFinite(entryPrice) || !Number.isFinite(laterPrice) || entryPrice <= 0) return "sans_objet";
  const pct = (laterPrice / entryPrice - 1) * 100;
  if (signal === "ACHETER") { if (pct >= minMovePct) return "gagnant"; if (pct <= -minMovePct) return "perdant"; return "neutre"; }
  if (signal === "VENDRE") { if (pct <= -minMovePct) return "gagnant"; if (pct >= minMovePct) return "perdant"; return "neutre"; }
  return "sans_objet";
}

/* Ajuste les poids par petits pas bornés — jamais de réinitialisation
   brutale, jamais de poids hors de [0.5, 1.6], pour que le moteur reste
   stable même après un signal aberrant isolé. */
function updateIndicatorWeights(weights, votes, signal, outcome) {
  const w = { ...defaultIndicatorWeights(), ...(weights || {}) };
  if (outcome !== "gagnant" && outcome !== "perdant") return w;
  const signalDir = signal === "ACHETER" ? 1 : signal === "VENDRE" ? -1 : 0;
  if (signalDir === 0) return w;
  for (const v of votes || []) {
    if (!v.name || !v.dir) continue;
    const agreedWithTrade = v.dir === signalDir;
    let delta;
    if (outcome === "gagnant") delta = agreedWithTrade ? WEIGHT_STEP : -WEIGHT_STEP / 2;
    else delta = agreedWithTrade ? -WEIGHT_STEP : WEIGHT_STEP / 2;
    w[v.name] = clampWeight((w[v.name] === undefined ? 1 : w[v.name]) + delta);
  }
  return w;
}

/* ==========================================================================
   Copilote IA (synthèse en langage naturel)
   --------------------------------------------------------------------------
   NB : ceci reste une synthèse générée par des règles à partir des résultats
   de la confluence ci-dessus — ce n'est PAS un appel à un modèle de langage.
   Un vrai « Copilote IA » génératif (section « IA d'analyse » du cahier des
   charges V2) nécessite un backend sécurisé détenant la clé d'un fournisseur
   LLM ; il n'y a aucune clé de ce type dans cette PWA. Cette fonction sert de
   brique d'interface stable : le jour où l'appel LLM existera côté serveur,
   il pourra remplacer ce texte sans changer l'UI qui l'affiche.
   ========================================================================== */
function buildCopilotBrief(r) {
  const name = r.item ? r.item.name : "cet instrument";
  const conf = r.confidence, grade = r.quality;
  const sideText = r.signal === "ACHETER" ? "un achat" : r.signal === "VENDRE" ? "une vente" : "d'attendre";
  let opening;
  if (r.insufficientData) opening = `Sur ${name}, l'historique disponible est trop court ou trop incomplet pour calculer une confiance fiable : confiance insuffisante. Yuki préfère ne rien affirmer plutôt que d'inventer une justification.`;
  else if (r.signal === "ATTENDRE") opening = `Sur ${name}, Yuki ne voit pas de configuration assez nette pour se positionner : mieux vaut attendre.`;
  else opening = `Sur ${name}, la confluence des indicateurs penche pour ${sideText}, avec une confiance de ${conf}% (note ${grade}).`;

  const strong = (r.reasons || []).filter(x => !/proche|faible|prudence|contraire|neutralis|dans le nuage|contradictoires/i.test(x)).slice(0, 3);
  const caveats = (r.reasons || []).filter(x => /proche|faible|prudence|contraire|neutralis|dans le nuage|contradictoires/i.test(x));

  let body = "";
  if (strong.length) body += " Les signaux qui vont dans ce sens : " + strong.join(", ") + ".";
  if (caveats.length) body += " Points de vigilance (risques qui restent présents) : " + caveats.join(", ") + ".";
  if (r.regime) body += ` Régime de marché actuel : ${r.regime.toLowerCase()}.`;
  if (r.correlation !== undefined && r.correlation !== null) body += ` Corrélation avec l'actif de référence : ${r.correlation.toFixed(2)}.`;
  if (r.scenarios) body += ` Scénarios : haussier ${r.scenarios.bullish.probability}%, baissier ${r.scenarios.bearish.probability}%, neutre ${r.scenarios.neutral.probability}%.`;

  let invalidation = "";
  if (r.signal !== "ATTENDRE") {
    invalidation = r.signal === "ACHETER"
      ? ` Scénario d'invalidation : si le prix casse durablement sous ${r.stop ? r.stop.toFixed(2) : "le stop"}, la lecture haussière est invalidée.`
      : ` Scénario d'invalidation : si le prix casse durablement au-dessus de ${r.stop ? r.stop.toFixed(2) : "le stop"}, la lecture baissière est invalidée.`;
  }

  const closing = r.signal === "ATTENDRE"
    ? " Ce n'est pas un conseil en investissement : à toi de décider si tu préfères patienter."
    : ` Stop et objectifs indicatifs affichés ci-dessus.${invalidation} Ce n'est pas un conseil en investissement, la décision finale te revient.`;

  return (opening + body + closing).replace(/\s+/g, " ").trim();
}
/* ==========================================================================
   Mode Simple — Résumé IA (2 phrases max) + Suggestion IA
   --------------------------------------------------------------------------
   Addendum Claude V3.3 "Mode Simple / Mode Expert" : le Mode Simple doit
   afficher uniquement le signal, le score IA, la confiance, le risque, le
   prix, l'objectif éventuel, un résumé IA (2 phrases maximum) et une
   suggestion IA — sans jargon technique (RSI, MACD, EMA, SMA, ATR, ADX,
   Bollinger, Fibonacci, Momentum, volatilité, multi-timeframe...).
   Cette fonction reste pure (aucun accès DOM, aucun fetch) : elle ne
   recalcule rien, elle reformule en langage simple le résultat déjà produit
   par le moteur d'analyse inchangé (buildConfluence / evaluateSignal).
   ========================================================================== */
function buildSimpleAiBrief(r, lang) {
  lang = lang === "en" ? "en" : "fr";
  const name = r.item ? r.item.name : (lang === "en" ? "this instrument" : "cet instrument");
  const riskWordEn = { "Faible": "low", "Modéré": "moderate", "Élevé": "high" };
  if (lang === "en") {
    if (r.insufficientData) {
      return {
        summary: `On ${name}, Yuki doesn't have enough reliable data to make a call. Better to wait for a clearer signal.`,
        suggestion: "Suggestion: don't take a position for now, check back a bit later."
      };
    }
    const sideText = r.signal === "ACHETER" ? "a buy" : r.signal === "VENDRE" ? "a sell" : "waiting";
    const riskWord = (riskWordEn[r.risk] || (r.risk || "moderate").toLowerCase());
    const summary = r.signal === "ATTENDRE"
      ? `On ${name}, Yuki doesn't see a clear enough setup to take a position: better to wait. Current confidence: ${r.confidence}%.`
      : `On ${name}, Yuki leans toward ${sideText} with ${r.confidence}% confidence. The estimated risk level is ${riskWord}.`;
    let suggestion;
    if (r.signal === "ATTENDRE") {
      suggestion = "Suggestion: stay out of the market for now, no decision is needed.";
    } else {
      const targetText = Number.isFinite(r.target) ? ` with an indicative target around ${r.target.toFixed(r.target < 10 ? 4 : 2)}` : "";
      suggestion = `Suggestion: consider ${sideText}${targetText}. This isn't investment advice, the final decision is yours.`;
    }
    return { summary: summary.replace(/\s+/g, " ").trim(), suggestion };
  }
  if (r.insufficientData) {
    return {
      summary: `Sur ${name}, Yuki n'a pas assez de données fiables pour se prononcer. Mieux vaut attendre un signal plus clair.`,
      suggestion: "Suggestion : ne prends pas position pour l'instant, réessaie un peu plus tard."
    };
  }
  const sideText = r.signal === "ACHETER" ? "un achat" : r.signal === "VENDRE" ? "une vente" : "d'attendre";
  const summary = r.signal === "ATTENDRE"
    ? `Sur ${name}, Yuki ne voit pas de configuration assez nette pour se positionner : mieux vaut attendre. Confiance actuelle : ${r.confidence}%.`
    : `Sur ${name}, Yuki penche pour ${sideText} avec une confiance de ${r.confidence}%. Le niveau de risque estimé est ${(r.risk || "modéré").toLowerCase()}.`;

  let suggestion;
  if (r.signal === "ATTENDRE") {
    suggestion = "Suggestion : rester à l'écart pour l'instant, aucune décision n'est nécessaire.";
  } else {
    const targetText = Number.isFinite(r.target) ? ` avec un objectif indicatif autour de ${r.target.toFixed(r.target < 10 ? 4 : 2)}` : "";
    suggestion = `Suggestion : envisager ${sideText}${targetText}. Ce n'est pas un conseil en investissement, la décision finale te revient.`;
  }
  return { summary: summary.replace(/\s+/g, " ").trim(), suggestion };
}
function higherTimeframe(h) {
  return h === "1h" ? "4h" : h === "4h" ? "1day" : "1week";
}
function confirmWithHigherTimeframe(a, ha) {
  if (a.signal === "ATTENDRE" || !ha || ha.signal === "ATTENDRE") {
    if (ha && ha.signal === "ATTENDRE") a.reasons.push("Unité de temps supérieure neutre");
    return a;
  }
  if (ha.signal === a.signal) {
    a.confidence = Math.min(97, a.confidence + 6);
    a.reasons.push(`Confirmé en unité de temps supérieure (${ha.signal})`);
  } else {
    a.confidence = Math.max(30, a.confidence - 18);
    a.reasons.push("⚠️ Signal contraire en unité de temps supérieure — faux signal possible");
    if (a.confidence < 58) { a.signal = "ATTENDRE"; a.reasons.push("Signal neutralisé par prudence"); }
  }
  a.quality = gradeQuality(a.confidence, a.rr, a.strongTrend);
  return a;
}

/* ==========================================================================
   Export CommonJS (Node) pour les tests automatisés et une éventuelle
   réutilisation côté serveur — ce module reste 100% pur (aucun accès DOM,
   aucun fetch), comme documenté en tête de fichier. Ignoré par le
   navigateur (pas de `module` global côté client).
   ========================================================================== */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    emaSeries, macd, bollinger, adxIndicator, superTrendIndicator, ichimokuIndicator,
    supportResistance, volumeConfirm, vwapIndicator, breakoutPullback, detectOrderBlocks,
    detectFVG, detectLiquidity, detectMarketStructure, pearsonCorrelation, relativeStrength,
    applyCorrelationRS, buildConfluence, riskLevel, gradeQuality, buildCopilotBrief,
    buildSimpleAiBrief,
    higherTimeframe, confirmWithHigherTimeframe, computeScenarios, evaluateSignal,
    updateIndicatorWeights, defaultIndicatorWeights, isDataInsufficient,
    clampWeight, WEIGHT_MIN, WEIGHT_MAX, WEIGHT_STEP, INDICATOR_NAMES
  };
}
