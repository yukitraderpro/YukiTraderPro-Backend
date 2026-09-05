/* BACKEND_9 — journal des signaux émis et précision mesurée. */
const Router = require("../http/router");
const { HttpError } = require("../http/server");
const authenticate = require("../middleware/authenticate");
const db = require("../db");
const logger = require("../logger");
const { createSignals } = require("../services/signalsService");
const marketRoutes = require("./market");

const signals = createSignals({ getDb: () => db.get(), market: marketRoutes._market, logger });

const router = new Router();

router.post("/", authenticate, async ctx => {
  const body = ctx.body || {};
  const list = Array.isArray(body.signals) ? body.signals : [body];
  if (list.length > 12) throw new HttpError(400, "12 signaux maximum par envoi.");
  let recorded = 0;
  for (const s of list) {
    try { if (signals.record(ctx.userId, s).recorded) recorded++; }
    catch (e) { throw new HttpError(400, "Signal invalide : " + e.message); }
  }
  ctx.res.json(200, { ok: true, recorded });
});

router.get("/stats", authenticate, async ctx => {
  const days = Math.max(7, Math.min(365, parseInt(ctx.query.days, 10) || 30));
  /* Résolution paresseuse et bornée : les signaux mûrs depuis le dernier passage. */
  try { await signals.resolvePending(30); } catch (_) {}
  ctx.res.json(200, signals.stats({ days, userId: ctx.userId }));
});

module.exports = router;
module.exports._signals = signals;
