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

/* BACKEND_12 — vérité terrain du suivi + vue brute pour l'administrateur. */
router.post("/observed", authenticate, async ctx => {
  try { ctx.res.json(200, { ok: true, ...signals.observe(ctx.userId, ctx.body || {}) }); }
  catch (e) { throw new HttpError(400, "Observation invalide : " + e.message); }
});
router.get("/recent", authenticate, async ctx => {
  const { requireAdmin } = require("./admin");
  await requireAdmin(ctx, async () => {});
  ctx.res.json(200, { signals: signals.recent(parseInt(ctx.query.limit, 10) || 60), reconciliation: signals.reconcile(30) });
});

module.exports = router;
module.exports._signals = signals;
