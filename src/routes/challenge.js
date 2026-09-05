/* BACKEND_10 — le défi du jour. */
const Router = require("../http/router");
const { HttpError } = require("../http/server");
const authenticate = require("../middleware/authenticate");
const db = require("../db");
const logger = require("../logger");
const { createChallenge } = require("../services/challengeService");
const marketRoutes = require("./market");
const challenge = createChallenge({ getDb: () => db.get(), market: marketRoutes._market, logger });
const router = new Router();
router.get("/today", authenticate, async ctx => { try { await challenge.resolvePending(50); } catch (_) {} ctx.res.json(200, { ...challenge.todayState(ctx.userId), stats: challenge.stats(ctx.userId) }); });
router.post("/", authenticate, async ctx => {
  try { const r = challenge.record(ctx.userId, ctx.body || {}); if (!r.recorded) throw new HttpError(409, "Tu as déjà joué le défi d'aujourd'hui."); ctx.res.json(200, { ok: true, ...r, state: challenge.todayState(ctx.userId) }); }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, e.message); }
});
router.get("/stats", authenticate, async ctx => { try { await challenge.resolvePending(50); } catch (_) {} ctx.res.json(200, challenge.stats(ctx.userId, Math.max(5, Math.min(200, parseInt(ctx.query.n, 10) || 30)))); });
module.exports = router;
module.exports._challenge = challenge;
