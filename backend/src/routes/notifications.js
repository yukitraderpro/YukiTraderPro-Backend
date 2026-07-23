const crypto = require("crypto");
const Router = require("../http/router");
const authenticate = require("../middleware/authenticate");
const db = require("../db");
const { HttpError } = require("../http/server");
const fcmService = require("../services/fcmService");
const logger = require("../logger");

const router = new Router();

router.post("/register-token", authenticate, async ctx => {
  const { fcmToken, deviceId } = ctx.body || {};
  if (!fcmToken) throw new HttpError(400, "fcmToken requis.");
  const conn = db.get();
  const existing = conn.prepare("SELECT id FROM notification_tokens WHERE user_id = ? AND fcm_token = ?").get(ctx.userId, fcmToken);
  if (!existing) {
    conn.prepare("INSERT INTO notification_tokens (id, user_id, device_id, fcm_token, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), ctx.userId, deviceId || null, fcmToken, Date.now());
  }
  ctx.res.json(200, { ok: true });
});

router.delete("/token/:token", authenticate, async ctx => {
  db.get().prepare("DELETE FROM notification_tokens WHERE user_id = ? AND fcm_token = ?").run(ctx.userId, ctx.params.token);
  ctx.res.json(200, { ok: true });
});

/* Envoie une notification de test à tous les appareils enregistrés de
   l'utilisateur — permet de vérifier la chaîne complète (app fermée
   comprise) sans attendre un vrai signal du scan planifié. */
router.post("/send-test", authenticate, async ctx => {
  const conn = db.get();
  const tokens = conn.prepare("SELECT fcm_token FROM notification_tokens WHERE user_id = ?").all(ctx.userId);
  if (!tokens.length) throw new HttpError(404, "Aucun appareil enregistré pour les notifications push.");
  const results = [];
  for (const t of tokens) {
    try {
      const r = await fcmService.sendPush(t.fcm_token, { title: "Yuki Trader Pro", body: "Notification de test — la chaîne push fonctionne." });
      results.push({ token: t.fcm_token.slice(0, 12) + "…", ok: r.ok });
    } catch (e) {
      logger.error("Échec envoi notification test", { error: e.message });
      results.push({ token: t.fcm_token.slice(0, 12) + "…", ok: false, error: e.message });
    }
  }
  ctx.res.json(200, { results });
});

module.exports = router;
