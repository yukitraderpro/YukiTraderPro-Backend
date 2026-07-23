/* ==========================================================================
   Route /api/waitlist — liste d'attente pré-lancement (landing page)
   --------------------------------------------------------------------------
   POST /api/waitlist        (public)  : inscrit un e-mail. Idempotent : un
                                         e-mail déjà inscrit renvoie 200
                                         (pas 409) pour ne pas révéler à un
                                         tiers si une adresse est inscrite.
   GET  /api/waitlist/count  (public)  : nombre d'inscrits (affichable sur
                                         la landing si souhaité).
   GET  /api/waitlist/export (admin)   : liste complète pour l'envoi des
                                         invitations au test fermé.
   --------------------------------------------------------------------------
   Anti-abus minimal, en mémoire, sans dépendance : 5 inscriptions max par
   IP par tranche de 10 minutes. Suffisant pour une landing pré-lancement ;
   à durcir (proxy/CDN, captcha) si abus constaté.
   ========================================================================== */
const crypto = require("crypto");
const Router = require("../http/router");
const authenticate = require("../middleware/authenticate");
const db = require("../db");
const { HttpError } = require("../http/server");
const logger = require("../logger");

const router = new Router();

const WINDOW_MS = 10 * 60 * 1000, MAX_PER_WINDOW = 5;
const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) { // borne mémoire : purge des IP inactives
    for (const [k, v] of hits) if (!v.some(t => now - t < WINDOW_MS)) hits.delete(k);
  }
  return false;
}

router.post("/", async ctx => {
  const email = String((ctx.body || {}).email || "").trim().toLowerCase();
  const source = String((ctx.body || {}).source || "landing").slice(0, 60);
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw new HttpError(400, "Adresse e-mail invalide.");
  const ip = (ctx.req.headers["x-forwarded-for"] || "").split(",")[0].trim() || ctx.req.socket.remoteAddress || "?";
  if (rateLimited(ip)) throw new HttpError(429, "Trop de tentatives, réessaie dans quelques minutes.");
  const conn = db.get();
  const existing = conn.prepare("SELECT id FROM waitlist WHERE email = ?").get(email);
  if (!existing) {
    conn.prepare("INSERT INTO waitlist (id, email, source, created_at) VALUES (?, ?, ?, ?)")
      .run(crypto.randomUUID(), email, source, Date.now());
    logger.info("Inscription liste d'attente", { source });
  }
  ctx.res.json(200, { ok: true });
});

router.get("/count", async ctx => {
  const row = db.get().prepare("SELECT COUNT(*) AS n FROM waitlist").get();
  ctx.res.json(200, { count: row.n });
});

async function requireAdmin(ctx, next) {
  const user = db.get().prepare("SELECT role FROM users WHERE id = ?").get(ctx.userId);
  if (!user || user.role !== "admin") throw new HttpError(403, "Accès administrateur requis.");
  await next();
}

router.get("/export", authenticate, requireAdmin, async ctx => {
  const rows = db.get().prepare("SELECT email, source, created_at FROM waitlist ORDER BY created_at ASC").all();
  ctx.res.json(200, { count: rows.length, entries: rows });
});

module.exports = router;
