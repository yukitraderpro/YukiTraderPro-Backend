/* BACKEND_6 — données de marché servies par le serveur avec la clé unique.
   Authentification requise (le quota est par utilisateur). `/status` est
   public : l'app décide dès la connexion si elle passe par le serveur ou
   par la clé personnelle. */
const Router = require("../http/router");
const { HttpError } = require("../http/server");
const authenticate = require("../middleware/authenticate");
const { getAccessState } = require("../middleware/requirePro");
const config = require("../config");
const db = require("../db");
const logger = require("../logger");
const { createMarketData, sqliteQuotaStore } = require("../services/marketData");

const market = createMarketData({
  apiKey: config.market.apiKey,
  quotaStore: sqliteQuotaStore(() => db.get()),
  logger
});

const router = new Router();

router.get("/status", async ctx => {
  const s = market.status();
  ctx.res.json(200, { configured: s.configured, cacheEntries: s.cacheEntries, creditsThisMinute: s.creditsThisMinute });
});

function translate(e) {
  if (e && e.status) return new HttpError(e.status, e.message, e.code ? { code: e.code, apiCode: e.apiCode || null } : undefined);
  return e;
}

router.get("/series", authenticate, async ctx => {
  try {
    const access = getAccessState(ctx.userId);
    const q = await market.consume(ctx.userId, access);
    const data = await market.series({ symbol: ctx.query.symbol, interval: ctx.query.interval, outputsize: ctx.query.outputsize, exchange: ctx.query.exchange });
    ctx.res.json(200, { ...data, quota_yuki: { tier: q.tier, remainingDay: q.remainingDay === Infinity ? null : q.remainingDay } });
  } catch (e) { throw translate(e); }
});

router.get("/price", authenticate, async ctx => {
  try {
    const access = getAccessState(ctx.userId);
    const q = await market.consume(ctx.userId, access);
    const data = await market.price({ symbol: ctx.query.symbol, exchange: ctx.query.exchange });
    ctx.res.json(200, { ...data, quota_yuki: { tier: q.tier, remainingDay: q.remainingDay === Infinity ? null : q.remainingDay } });
  } catch (e) { throw translate(e); }
});

router.get("/search", authenticate, async ctx => {
  try {
    const access = getAccessState(ctx.userId);
    const q = await market.consume(ctx.userId, access);
    const data = await market.search({ query: ctx.query.symbol, outputsize: ctx.query.outputsize });
    ctx.res.json(200, { ...data, quota_yuki: { tier: q.tier, remainingDay: q.remainingDay === Infinity ? null : q.remainingDay } });
  } catch (e) { throw translate(e); }
});

module.exports = router;
module.exports._market = market;
