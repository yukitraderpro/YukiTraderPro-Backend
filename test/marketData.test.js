/* BACKEND_6 — la promesse chiffrée faite à Simon : « mille personnes sur
   NVDA = un appel ». Chaque test ci-dessous EXÉCUTE le service avec un
   faux Twelve Data qui compte ses appels. */
const test = require("node:test");
const assert = require("node:assert");
const { createMarketData, memoryQuotaStore, DEFAULT_LIMITS } = require("../src/services/marketData");

function fakeTwelve({ fail } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (fail && fail(calls.length)) return { ok: true, status: 200, json: async () => ({ status: "error", code: 429, message: "You have run out of API credits for the current minute." }) };
    const sym = decodeURIComponent(url.match(/symbol=([^&]+)/)[1]);
    if (url.includes("/price?")) return { ok: true, status: 200, json: async () => ({ price: "119.69" }) };
    if (url.includes("/earnings?")) return { ok: true, status: 200, json: async () => ({ meta: { symbol: "NVDA" }, earnings: [{ date: "2026-09-10", time: "After Hours", eps_estimate: 1.2, eps_actual: null }], status: "ok" }) };
    if (url.includes("/symbol_search?")) return { ok: true, status: 200, json: async () => ({ data: [{ symbol: "NVDA", instrument_name: "NVIDIA" }], status: "ok" }) };
    return { ok: true, status: 200, json: async () => ({ meta: { symbol: sym }, values: [{ datetime: "2026-09-03 15:30:00", close: "119.5" }], status: "ok" }) };
  };
  return { calls, fetchImpl };
}
function clock(start = 1_000_000_020_000) { let t = start; return { now: () => t, advance: ms => { t += ms; } }; }

test("1 000 demandes de NVDA dans la minute = UN appel Twelve Data ; l'âge et la provenance sont dits", async () => {
  const td = fakeTwelve(), c = clock();
  const m = createMarketData({ apiKey: "K", fetchImpl: td.fetchImpl, now: c.now });
  const first = await m.series({ symbol: "NVDA", interval: "15min", outputsize: 120 });
  assert.strictEqual(first.meta_yuki.source, "live");
  for (let i = 0; i < 999; i++) { c.advance(50); await m.series({ symbol: "NVDA", interval: "15min", outputsize: 120 }); }
  assert.strictEqual(td.calls.length, 1, "un seul appel réel pour mille demandes");
  const last = await m.series({ symbol: "NVDA", interval: "15min", outputsize: 120 });
  assert.strictEqual(last.meta_yuki.source, "cache");
  assert.ok(last.meta_yuki.ageMs >= 49_950 && last.meta_yuki.ageMs < 60_000, "âge réel de la copie : " + last.meta_yuki.ageMs);
  assert.strictEqual(m.status().cacheHits, 1000);
});

test("regroupement en vol : 200 demandes simultanées sur un cache vide déclenchent UN appel et reçoivent toutes la même réponse", async () => {
  let release; const gate = new Promise(r => { release = r; });
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); await gate; return { ok: true, status: 200, json: async () => ({ values: [{ close: "1" }], status: "ok" }) }; };
  const m = createMarketData({ apiKey: "K", fetchImpl });
  const all = Promise.all(Array.from({ length: 200 }, () => m.series({ symbol: "SMH", interval: "1min" })));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(calls.length, 1, "un appel en vol, pas 200");
  release();
  const results = await all;
  assert.strictEqual(results.length, 200);
  assert.strictEqual(m.status().coalesced, 199);
  assert.strictEqual(new Set(results.map(r => r.meta_yuki.fetchedAt)).size, 1, "tous reçoivent la même copie");
});

test("la durée de vie suit l'intervalle : une bougie de 1 min se rafraîchit toutes les 15 s, une bougie de 15 min toutes les 60 s", async () => {
  const td = fakeTwelve(), c = clock();
  const m = createMarketData({ apiKey: "K", fetchImpl: td.fetchImpl, now: c.now });
  await m.series({ symbol: "QQQ", interval: "1min" }); await m.series({ symbol: "QQQ", interval: "15min" });
  assert.strictEqual(td.calls.length, 2, "deux intervalles = deux entrées de cache");
  c.advance(16_000);
  await m.series({ symbol: "QQQ", interval: "1min" }); await m.series({ symbol: "QQQ", interval: "15min" });
  assert.strictEqual(td.calls.length, 3, "après 16 s : la 1 min est refaite, la 15 min est encore bonne");
  c.advance(50_000);
  await m.series({ symbol: "QQQ", interval: "15min" });
  assert.strictEqual(td.calls.length, 4, "après 66 s : la 15 min est refaite");
});

test("les crédits par minute dépendent des INSTRUMENTS, pas des utilisateurs : 40 instruments, 10 000 demandes → 40 crédits", async () => {
  const td = fakeTwelve(), c = clock();
  const m = createMarketData({ apiKey: "K", fetchImpl: td.fetchImpl, now: c.now });
  const syms = Array.from({ length: 40 }, (_, i) => "S" + i);
  for (let i = 0; i < 10_000; i++) { await m.series({ symbol: syms[i % 40], interval: "15min" }); c.advance(2); }
  assert.strictEqual(td.calls.length, 40);
  assert.strictEqual(m.status().creditsThisMinute, 40);
});

test("Twelve Data répond 429 : le serveur sert la dernière copie en la marquant « stale », et ne ment jamais sur son âge", async () => {
  const td = fakeTwelve({ fail: n => n >= 2 }), c = clock();
  const m = createMarketData({ apiKey: "K", fetchImpl: td.fetchImpl, now: c.now });
  await m.series({ symbol: "VGT", interval: "15min" });
  c.advance(61_000);
  const r = await m.series({ symbol: "VGT", interval: "15min" });
  assert.strictEqual(r.meta_yuki.source, "stale");
  assert.ok(/API credits/.test(r.meta_yuki.reason), "la raison de la copie périmée est transmise");
  assert.ok(r.meta_yuki.ageMs >= 61_000);
  c.advance(15 * 60_000);
  await assert.rejects(() => m.series({ symbol: "VGT", interval: "15min" }), e => e.status === 429, "au-delà de 15 min, on ne sert plus une copie morte : l'erreur remonte");
});

test("sans clé serveur : 503 « non configurée » — l'app saura se replier sur les clés personnelles", async () => {
  const m = createMarketData({ apiKey: "" });
  assert.strictEqual(m.configured(), false);
  await assert.rejects(() => m.series({ symbol: "NVDA", interval: "15min" }), e => e.status === 503 && e.code === "not_configured");
});

test("entrées invalides refusées avant tout appel : symbole, intervalle", async () => {
  const td = fakeTwelve();
  const m = createMarketData({ apiKey: "K", fetchImpl: td.fetchImpl });
  await assert.rejects(() => m.series({ symbol: "NVDA; DROP", interval: "15min" }), e => e.status === 400);
  await assert.rejects(() => m.series({ symbol: "NVDA", interval: "3min" }), e => e.status === 400);
  assert.strictEqual(td.calls.length, 0);
});

test("quotas par palier : 200/jour en gratuit avec un message qui nomme l'abonnement, 5 000 en abonné, illimité en admin, et un plafond par minute", async () => {
  const c = clock();
  const m = createMarketData({ apiKey: "K", fetchImpl: fakeTwelve().fetchImpl, now: c.now, quotaStore: memoryQuotaStore() });
  for (let i = 0; i < 200; i++) { await m.consume("u-free", { allowed: false, reason: "trial_expired" }); c.advance(2100); }
  await assert.rejects(() => m.consume("u-free", { allowed: false, reason: "trial_expired" }), e => e.status === 429 && e.code === "quota_day" && /Fondateur/.test(e.message));
  const sub = await m.consume("u-sub", { allowed: true, reason: "subscribed" });
  assert.strictEqual(sub.tier, "subscribed"); assert.strictEqual(sub.remainingDay, DEFAULT_LIMITS.subscribed.perDay - 1);
  const adm = await m.consume("u-adm", { allowed: true, reason: "admin" });
  assert.strictEqual(adm.remainingDay, Infinity);
  for (let i = 0; i < 120; i++) await m.consume("u-burst", { allowed: true, reason: "subscribed" });
  await assert.rejects(() => m.consume("u-burst", { allowed: true, reason: "subscribed" }), e => e.code === "quota_minute", "plafond par minute pour protéger le serveur");
  c.advance(61_000);
  await m.consume("u-burst", { allowed: true, reason: "subscribed" });
});

test("prix : cache de 20 s partagé par tous ceux qui suivent le même actif", async () => {
  const td = fakeTwelve(), c = clock();
  const m = createMarketData({ apiKey: "K", fetchImpl: td.fetchImpl, now: c.now });
  for (let i = 0; i < 50; i++) { await m.price({ symbol: "VGT" }); c.advance(300); }
  assert.strictEqual(td.calls.length, 1);
  c.advance(21_000); await m.price({ symbol: "VGT" });
  assert.strictEqual(td.calls.length, 2);
});

test("la route est montée sous /api/market et la config lit MARKET_DATA_KEY puis CONTEXT_DATA_KEY", () => {
  const fs = require("node:fs"), path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const cfg = fs.readFileSync(path.join(__dirname, "..", "src", "config.js"), "utf8");
  assert.ok(app.includes('app.use("/api/market", marketRoutes)'));
  assert.ok(cfg.includes('required("MARKET_DATA_KEY", "") || required("CONTEXT_DATA_KEY", "")'));
  const route = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "market.js"), "utf8");
  assert.ok(route.includes('router.get("/series", authenticate') && route.includes('router.get("/price", authenticate'), "les données exigent un compte");
  assert.ok(route.includes('router.get("/status"'), "le statut est public");
});

test("BACKEND_7 — la place de cotation fait partie de la clé de cache : MC (Euronext) et MC (sans place) sont deux instruments", async () => {
  const td = fakeTwelve();
  const m = createMarketData({ apiKey: "K", fetchImpl: td.fetchImpl });
  await m.series({ symbol: "MC", interval: "15min", exchange: "EURONEXT" });
  await m.series({ symbol: "MC", interval: "15min" });
  await m.series({ symbol: "MC", interval: "15min", exchange: "EURONEXT" });
  assert.strictEqual(td.calls.length, 2, "deux clés de cache, deux appels, pas trois");
  assert.ok(td.calls[0].includes("exchange=EURONEXT"));
  await assert.rejects(() => m.series({ symbol: "MC", interval: "15min", exchange: "EURO NEXT;" }), e => e.status === 400);
});

test("BACKEND_7 — recherche d'actif par le serveur : une heure de cache par requête, entrée contrôlée ; l'historique long terme peut demander 1 100 bougies", async () => {
  const td = fakeTwelve(), c = clock();
  const m = createMarketData({ apiKey: "K", fetchImpl: td.fetchImpl, now: c.now });
  await m.search({ query: "nvid" }); await m.search({ query: "NVID" }); await m.search({ query: "nvid " });
  assert.strictEqual(td.calls.length, 1, "trois graphies, une seule requête");
  await assert.rejects(() => m.search({ query: "n" }), e => e.status === 400);
  await assert.rejects(() => m.search({ query: "<script>" }), e => e.status === 400);
  await m.series({ symbol: "MC", interval: "1week", outputsize: 1100, exchange: "EURONEXT" });
  assert.ok(td.calls.some(u => /outputsize=1100/.test(u)), "1 100 semaines acceptées (21 ans)");
  const route = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "routes", "market.js"), "utf8");
  assert.ok(route.includes('router.get("/search", authenticate'));
});

test("BACKEND_8 — dates de résultats : un appel par action et par jour, fenêtre d'aujourd'hui à +60 jours, route protégée", async () => {
  const td = fakeTwelve(), c = clock();
  const m = createMarketData({ apiKey: "K", fetchImpl: td.fetchImpl, now: c.now });
  const r = await m.earnings({ symbol: "NVDA" });
  assert.strictEqual(r.earnings[0].date, "2026-09-10");
  for (let i = 0; i < 500; i++) { c.advance(60000); await m.earnings({ symbol: "NVDA" }); }
  assert.strictEqual(td.calls.length, 1, "500 demandes en 8 h = 1 appel");
  assert.ok(/start_date=\d{4}-\d{2}-\d{2}&end_date=\d{4}-\d{2}-\d{2}/.test(td.calls[0]));
  c.advance(25 * 3600000); await m.earnings({ symbol: "NVDA" });
  assert.strictEqual(td.calls.length, 2, "le lendemain, on redemande");
  const route = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "routes", "market.js"), "utf8");
  assert.ok(route.includes('router.get("/earnings", authenticate'));
});
