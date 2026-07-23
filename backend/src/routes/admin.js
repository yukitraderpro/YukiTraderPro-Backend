/* ==========================================================================
   Routes d'administration — addendum V3.1 « Abonnements »
   --------------------------------------------------------------------------
   Écran d'administration demandé explicitement : modifier les prix,
   activer/désactiver des offres, suivre le nombre d'abonnés — sans jamais
   republier l'application (tout est en base, lu dynamiquement par
   `GET /api/billing/offers`).
   ========================================================================== */
const Router = require("../http/router");
const authenticate = require("../middleware/authenticate");
const db = require("../db");
const { HttpError } = require("../http/server");
const offersService = require("../services/subscriptionOffersService");

const router = new Router();

/* Vérifie le rôle en base (pas seulement la revendication du JWT, qui peut
   être obsolète si l'utilisateur a été promu/rétrogradé après l'émission de
   son access token courant). */
async function requireAdmin(ctx, next) {
  const user = db.get().prepare("SELECT role FROM users WHERE id = ?").get(ctx.userId);
  if (!user || user.role !== "admin") throw new HttpError(403, "Accès administrateur requis.");
  await next();
}

router.get("/offers", authenticate, requireAdmin, async ctx => {
  ctx.res.json(200, { offers: offersService.listAllOffers() });
});

router.post("/offers", authenticate, requireAdmin, async ctx => {
  const { name, description, priceCents, seatLimit, active, sortOrder } = ctx.body || {};
  try {
    const offer = offersService.createOffer({ name, description, priceCents, seatLimit, active, sortOrder }, ctx.userId);
    ctx.res.json(201, { offer });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});

router.put("/offers/:id", authenticate, requireAdmin, async ctx => {
  try {
    const offer = offersService.updateOffer(ctx.params.id, ctx.body || {}, ctx.userId);
    ctx.res.json(200, { offer });
  } catch (e) {
    throw new HttpError(404, e.message);
  }
});

router.get("/offers/:id/price-history", authenticate, requireAdmin, async ctx => {
  ctx.res.json(200, { history: offersService.getPriceHistory(ctx.params.id) });
});

router.get("/subscribers", authenticate, requireAdmin, async ctx => {
  ctx.res.json(200, offersService.subscriberCounts());
});

router.get("/users", authenticate, requireAdmin, async ctx => {
  const rows = db.get().prepare("SELECT id, email, role, created_at, trial_until, subscribed FROM users ORDER BY created_at DESC LIMIT 200").all();
  ctx.res.json(200, { users: rows });
});

const VALID_ROLES = ["free", "pro", "admin"];

/* Changement de rôle — Partie 1.3 du cahier des charges V4 : c'est ici,
   côté serveur et derrière `requireAdmin`, que le rôle est décidé. Le
   client (web/Android) ne fait plus jamais cette mutation localement. */
router.put("/users/:id/role", authenticate, requireAdmin, async ctx => {
  const { role } = ctx.body || {};
  if (!VALID_ROLES.includes(role)) throw new HttpError(400, "Rôle invalide.");
  const conn = db.get();
  const target = conn.prepare("SELECT id, email, role FROM users WHERE id = ?").get(ctx.params.id);
  if (!target) throw new HttpError(404, "Utilisateur introuvable.");
  if (target.id === ctx.userId && role !== "admin") {
    throw new HttpError(400, "Un administrateur ne peut pas retirer son propre rôle admin depuis cet écran.");
  }
  conn.prepare("UPDATE users SET role = ?, subscribed = CASE WHEN ? THEN 1 ELSE subscribed END WHERE id = ?")
    .run(role, role === "pro" ? 1 : 0, target.id);
  conn.prepare("INSERT INTO audit_log (id, user_id, action, ip, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), ctx.userId, "admin.user.role_changed", ctx.req.socket && ctx.req.socket.remoteAddress || null,
      JSON.stringify({ targetUserId: target.id, targetEmail: target.email, from: target.role, to: role }), Date.now());
  const updated = conn.prepare("SELECT id, email, role, created_at, trial_until, subscribed FROM users WHERE id = ?").get(target.id);
  ctx.res.json(200, { user: updated });
});

/* Suppression de compte par un administrateur : révoque aussi tous ses
   refresh tokens (déconnexion immédiate de tous ses appareils). */
router.delete("/users/:id", authenticate, requireAdmin, async ctx => {
  const conn = db.get();
  const target = conn.prepare("SELECT id, email FROM users WHERE id = ?").get(ctx.params.id);
  if (!target) throw new HttpError(404, "Utilisateur introuvable.");
  if (target.id === ctx.userId) throw new HttpError(400, "Un administrateur ne peut pas supprimer son propre compte depuis cet écran.");
  conn.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), target.id);
  conn.prepare("DELETE FROM users WHERE id = ?").run(target.id);
  conn.prepare("INSERT INTO audit_log (id, user_id, action, ip, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), ctx.userId, "admin.user.deleted", ctx.req.socket && ctx.req.socket.remoteAddress || null,
      JSON.stringify({ targetUserId: target.id, targetEmail: target.email }), Date.now());
  ctx.res.json(200, { ok: true });
});

module.exports = router;
