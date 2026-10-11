/* BACKEND_17 — retours d'essai : question dans l'app, réponse, vue admin. */
const Router = require("../http/router");
const { HttpError } = require("../http/server");
const authenticate = require("../middleware/authenticate");
const db = require("../db");
const logger = require("../logger");
const config = require("../config");
const mail = require("../services/mailService");
const { createFeedback } = require("../services/feedbackService");

const feedback = createFeedback({ getDb: () => db.get(), mail, config: { ...config.trialFeedback, appPublicUrl: config.appPublicUrl }, logger });

const router = new Router();
router.get("/eligibility", authenticate, async ctx => { ctx.res.json(200, feedback.eligibility(ctx.userId)); });
router.post("/", authenticate, async ctx => {
  try { ctx.res.json(200, { ok: true, ...feedback.record(ctx.userId, ctx.body || {}) }); }
  catch (e) { throw new HttpError(400, "Réponse invalide : " + e.message); }
});
router.get("/summary", authenticate, async ctx => {
  const { requireAdmin } = require("./admin");
  await requireAdmin(ctx, async () => {});
  ctx.res.json(200, feedback.summary());
});

module.exports = router;
module.exports._feedback = feedback;
