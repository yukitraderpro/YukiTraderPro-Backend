const Router = require("../http/router");
const authenticate = require("../middleware/authenticate");
const authService = require("../services/authService");
const { HttpError } = require("../http/server");
const db = require("../db");
const crypto = require("crypto");
const config = require("../config");
const logger = require("../logger");
const mailService = require("../services/mailService");
const { hashPassword } = require("../crypto/password");

const router = new Router();

const REFRESH_COOKIE = config.refreshCookieName;
const cookieOpts = { httpOnly: true, secure: config.cookieSecure, sameSite: config.cookieSameSite, path: "/api/auth", maxAgeSeconds: config.jwtRefreshTtlSeconds };

/* Le refresh token n'est plus jamais renvoyé dans le corps JSON ni stocké
   côté client (localStorage) : il est posé en cookie HttpOnly+Secure,
   inaccessible au JavaScript de la page (protection XSS), et automatiquement
   rejoué par le navigateur sur les appels à /api/auth/refresh et
   /api/auth/logout (voir cahier des charges V4 — Partie 1.4). */
function setRefreshCookie(ctx, refreshToken) { ctx.res.setCookie(REFRESH_COOKIE, refreshToken, cookieOpts); }
function clearRefreshCookie(ctx) { ctx.res.clearCookie(REFRESH_COOKIE, cookieOpts); }
function stripRefreshToken({ refreshToken, ...rest }) { return rest; }

router.post("/register", async ctx => {
  const { email, password, deviceId, deviceLabel, platform } = ctx.body || {};
  const user = authService.register(email, password);
  const tokens = authService.login(email, password, deviceId);
  registerDevice(user.id, deviceId, deviceLabel, platform);
  setRefreshCookie(ctx, tokens.refreshToken);
  ctx.res.json(201, { user, ...stripRefreshToken(tokens) });
});

router.post("/login", async ctx => {
  const { email, password, deviceId, deviceLabel, platform } = ctx.body || {};
  if (!email || !password) throw new HttpError(400, "E-mail et mot de passe requis.");
  const result = authService.login(email, password, deviceId);
  registerDevice(result.user.id, deviceId, deviceLabel, platform);
  setRefreshCookie(ctx, result.refreshToken);
  ctx.res.json(200, { user: result.user, ...stripRefreshToken(result) });
});

router.post("/refresh", async ctx => {
  const refreshToken = ctx.cookies[REFRESH_COOKIE];
  const { deviceId } = ctx.body || {};
  if (!refreshToken) throw new HttpError(401, "Session absente ou expirée.");
  const result = authService.refresh(refreshToken, deviceId);
  setRefreshCookie(ctx, result.refreshToken);
  ctx.res.json(200, stripRefreshToken(result));
});

router.post("/logout", async ctx => {
  const refreshToken = ctx.cookies[REFRESH_COOKIE];
  if (refreshToken) authService.logout(refreshToken);
  clearRefreshCookie(ctx);
  ctx.res.json(200, { ok: true });
});

/* Suppression définitive du compte (RGPD + exigence Google Play).
   Authentification requise ET mot de passe reconfirmé : une suppression est
   irréversible, on ne se contente pas d'une session valide. Le cookie de
   rafraîchissement est effacé dans la foulée pour couper la session. */
router.post("/delete-account", authenticate, async ctx => {
  const { password } = ctx.body || {};
  const result = authService.deleteAccount(ctx.userId, password);
  clearRefreshCookie(ctx);
  ctx.res.json(200, {
    ok: true,
    deleted: true,
    /* On rappelle explicitement que l'abonnement Play n'est pas résilié par
       cette action : il appartient à Google, pas à nous. */
    subscriptionNotice: result.hadSubscription
      ? "Votre compte a été supprimé. Attention : votre abonnement Google Play reste actif et doit être résilié depuis le Play Store pour éviter tout nouveau prélèvement."
      : null
  });
});

/* ==========================================================================
   Réinitialisation de mot de passe (V4.11)
   --------------------------------------------------------------------------
   Deux étapes : /forgot-password envoie un lien par e-mail, /reset-password
   consomme le jeton et change le mot de passe.

   Trois précautions de sécurité :
   1. Anti-énumération — la réponse de /forgot-password est TOUJOURS identique,
      que l'e-mail existe ou non. Sinon l'endpoint devient un oracle permettant
      de découvrir quels comptes existent.
   2. Jeton jamais stocké en clair — seul son SHA-256 est en base, comme pour
      les refresh tokens. Une fuite de la base ne permet pas de forger un lien.
   3. Invalidation des sessions — changer le mot de passe révoque tous les
      refresh tokens : si un attaquant avait une session ouverte, elle tombe.
   ========================================================================== */

function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }

router.post("/forgot-password", async ctx => {
  const { email } = ctx.body || {};
  const genericResponse = {
    ok: true,
    message: "Si un compte existe pour cette adresse, un e-mail de réinitialisation vient d'être envoyé. Pensez à vérifier vos courriers indésirables."
  };

  if (!email || typeof email !== "string") {
    ctx.res.json(200, genericResponse);
    return;
  }

  const normalized = authService.normEmail(email);
  const conn = db.get();
  const user = conn.prepare("SELECT id, email FROM users WHERE email = ?").get(normalized);

  if (!user) {
    /* Compte inexistant : on répond exactement comme en cas de succès. */
    logger.info("[auth] Demande de réinitialisation pour une adresse inconnue.");
    ctx.res.json(200, genericResponse);
    return;
  }

  /* Un seul jeton actif à la fois : les précédents sont neutralisés. */
  conn.prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL")
    .run(Date.now(), user.id);

  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  conn.prepare(`
    INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, used_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(crypto.randomUUID(), user.id, hashToken(token), now, now + config.passwordResetTtlSeconds * 1000);

  const resetUrl = `${config.appPublicUrl}/reinitialiser-mot-de-passe.html?token=${encodeURIComponent(token)}`;
  await mailService.sendPasswordReset(user.email, resetUrl);

  ctx.res.json(200, genericResponse);
});

router.post("/reset-password", async ctx => {
  const { token, password } = ctx.body || {};
  if (!token || !password) throw new HttpError(400, "Jeton et nouveau mot de passe requis.");
  if (String(password).length < 6) throw new HttpError(400, "Le mot de passe doit contenir au moins 6 caractères.");

  const conn = db.get();
  const row = conn.prepare("SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?")
    .get(hashToken(String(token)));

  /* Message volontairement identique pour un jeton inexistant, déjà utilisé ou
     expiré : aucune information exploitable n'est renvoyée. */
  const invalid = () => new HttpError(400, "Ce lien de réinitialisation est invalide ou a expiré. Veuillez en demander un nouveau.");
  if (!row || row.used_at || row.expires_at < Date.now()) throw invalid();

  const user = conn.prepare("SELECT id, email FROM users WHERE id = ?").get(row.user_id);
  if (!user) throw invalid();

  /* node:sqlite n'expose pas l'API .transaction() de better-sqlite3 : on
     encadre manuellement par BEGIN/COMMIT, comme dans authService.deleteAccount. */
  conn.exec("BEGIN");
  try {
    conn.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(String(password)), user.id);
    conn.prepare("UPDATE password_resets SET used_at = ? WHERE id = ?").run(Date.now(), row.id);
    /* Toutes les sessions existantes tombent : c'est le comportement attendu
       après un changement de mot de passe, et la seule façon de couper l'accès
       d'un tiers qui aurait compromis le compte. */
    conn.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(Date.now(), user.id);
    conn.exec("COMMIT");
  } catch (e) {
    try { conn.exec("ROLLBACK"); } catch {}
    throw e;
  }

  logger.info("[auth] Mot de passe réinitialisé avec succès.");
  clearRefreshCookie(ctx);
  ctx.res.json(200, { ok: true, message: "Votre mot de passe a été modifié. Vous pouvez maintenant vous connecter." });
});

router.get("/me", authenticate, async ctx => {
  const user = authService.getUserById(ctx.userId);
  if (!user) throw new HttpError(404, "Utilisateur introuvable.");
  ctx.res.json(200, {
    user,
    isPro: authService.isPro(user),
    isTrialActive: authService.isTrialActive(user),
    devices: db.get().prepare("SELECT id, label, platform, first_seen_at, last_seen_at FROM devices WHERE user_id = ?").all(ctx.userId)
  });
});

function registerDevice(userId, deviceId, label, platform) {
  if (!deviceId) return;
  const conn = db.get();
  const now = Date.now();
  const existing = conn.prepare("SELECT id FROM devices WHERE id = ?").get(deviceId);
  if (existing) {
    conn.prepare("UPDATE devices SET last_seen_at = ?, label = COALESCE(?, label) WHERE id = ?").run(now, label || null, deviceId);
  } else {
    conn.prepare("INSERT INTO devices (id, user_id, label, platform, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(deviceId, userId, label || null, platform || null, now, now);
  }
}

module.exports = router;
