const Router = require("../http/router");
const authenticate = require("../middleware/authenticate");
const authService = require("../services/authService");
const { HttpError } = require("../http/server");
const db = require("../db");
const crypto = require("crypto");
const config = require("../config");

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
