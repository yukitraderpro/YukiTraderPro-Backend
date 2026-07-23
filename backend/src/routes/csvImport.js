/* ==========================================================================
   Routes d'import CSV — addendum V3.2
   --------------------------------------------------------------------------
   Toutes les routes sont authentifiées et scoped à `ctx.userId` — aucune
   route de ce fichier n'accepte un user_id venant du corps de la requête,
   ce qui garantit mécaniquement l'isolation entre utilisateurs (règle non
   négociable n°3 du cahier des charges V3.2).
   ========================================================================== */
const Router = require("../http/router");
const authenticate = require("../middleware/authenticate");
const { HttpError } = require("../http/server");
const svc = require("../services/csvImportService");

const router = new Router();

function wrap(fn) {
  return async ctx => {
    try { await fn(ctx); }
    catch (e) { throw new HttpError(/introuvable/i.test(e.message) ? 404 : 400, e.message); }
  };
}

router.post("/imports", authenticate, wrap(async ctx => {
  const { filename, source, destination, csvText, mimeType } = ctx.body || {};
  const preview = svc.createImportPreview(ctx.userId, { filename, source, destination, csvText, mimeType });
  ctx.res.json(201, preview);
}));

router.get("/imports", authenticate, wrap(async ctx => {
  ctx.res.json(200, { imports: svc.listImports(ctx.userId) });
}));

router.get("/imports/:id", authenticate, wrap(async ctx => {
  ctx.res.json(200, svc.getImportReport(ctx.userId, ctx.params.id));
}));

router.post("/imports/:id/confirm", authenticate, wrap(async ctx => {
  const { mapping, duplicateStrategy } = ctx.body || {};
  const report = svc.confirmImport(ctx.userId, ctx.params.id, { mapping, duplicateStrategy });
  ctx.res.json(200, report);
}));

router.post("/imports/:id/cancel", authenticate, wrap(async ctx => {
  svc.cancelPendingImport(ctx.userId, ctx.params.id);
  ctx.res.json(200, { ok: true });
}));

router.get("/imports/:id/impact", authenticate, wrap(async ctx => {
  const rowIds = ctx.query.rowIds ? ctx.query.rowIds.split(",") : null;
  ctx.res.json(200, svc.previewDeletionImpact(ctx.userId, ctx.params.id, rowIds));
}));

router.delete("/imports/:id", authenticate, wrap(async ctx => {
  const scope = ctx.query.scope || "all";
  if (scope === "file_only") ctx.res.json(200, svc.deleteFileOnly(ctx.userId, ctx.params.id));
  else ctx.res.json(200, svc.softDeleteImport(ctx.userId, ctx.params.id, ctx.body && ctx.body.retentionDays));
}));

router.post("/imports/:id/rows/delete", authenticate, wrap(async ctx => {
  const { rowIds } = ctx.body || {};
  ctx.res.json(200, svc.softDeleteRows(ctx.userId, ctx.params.id, rowIds));
}));

router.post("/imports/:id/restore", authenticate, wrap(async ctx => {
  ctx.res.json(200, svc.restoreImport(ctx.userId, ctx.params.id));
}));

router.get("/rows", authenticate, wrap(async ctx => {
  ctx.res.json(200, { rows: svc.listRows(ctx.userId, ctx.query) });
}));

router.get("/mapping/:source", authenticate, wrap(async ctx => {
  ctx.res.json(200, { mapping: svc.getRememberedMapping(ctx.userId, ctx.params.source) });
}));

module.exports = router;
