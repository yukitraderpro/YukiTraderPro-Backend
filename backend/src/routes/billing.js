const crypto = require("crypto");
const Router = require("../http/router");
const authenticate = require("../middleware/authenticate");
const db = require("../db");
const { HttpError } = require("../http/server");
const googlePlayService = require("../services/googlePlayService");
const offersService = require("../services/subscriptionOffersService");
const logger = require("../logger");

const router = new Router();

/* Offres actuellement en vigueur — endpoint public (pas d'authentification
   requise) : l'écran d'abonnement doit pouvoir afficher le tarif réel avant
   même que l'utilisateur soit connecté. AUCUN prix n'est codé en dur côté
   client : tout vient d'ici (addendum V3.1 « Abonnements »). */
router.get("/offers", async ctx => {
  ctx.res.json(200, { offers: offersService.listActiveOffers() });
});

router.get("/my-offer", authenticate, async ctx => {
  ctx.res.json(200, { offer: offersService.getUserCurrentOffer(ctx.userId) });
});

/* Vérifie un achat/abonnement Google Play côté serveur — c'est cette route,
   et elle seule, qui doit être appelée par l'app Android (TWA) après un
   achat via la Billing Library. Le client ne doit jamais décider seul
   qu'un abonnement est actif : voir README_BACKEND.md §Google Play Billing
   pour le flux complet et sa limite (nécessite un enrobage Android/TWA,
   une PWA pure ne peut pas appeler la Billing Library — documenté aussi
   dans Difficultes_YukiTraderPro_V3.md). */
router.post("/verify-purchase", authenticate, async ctx => {
  const { purchaseToken, subscriptionId } = ctx.body || {};
  if (!purchaseToken || !subscriptionId) throw new HttpError(400, "purchaseToken et subscriptionId requis.");

  let result;
  try {
    result = await googlePlayService.verifySubscription(purchaseToken, subscriptionId);
  } catch (e) {
    logger.error("Erreur vérification Google Play", { error: e.message });
    throw new HttpError(502, "Impossible de vérifier l'achat auprès de Google Play pour le moment.");
  }

  const conn = db.get();
  const now = Date.now();
  conn.prepare(`
    INSERT INTO subscriptions (id, user_id, product_id, purchase_token, status, verified_at, expiry_at, raw_response)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), ctx.userId, subscriptionId, purchaseToken, result.status, now, result.expiryAt || null, JSON.stringify(result.raw || {}));

  const active = result.status === "active";
  conn.prepare("UPDATE users SET subscribed = ?, role = CASE WHEN ? THEN 'pro' WHEN role = 'pro' THEN 'free' ELSE role END WHERE id = ?")
    .run(active ? 1 : 0, active ? 1 : 0, ctx.userId);

  /* Offre dynamique (addendum V3.1) : assigne une offre (avec tarif
     verrouillé) au premier abonnement actif, ou libère la place si
     l'abonnement n'est plus actif — voir subscriptionOffersService.js. */
  let offer = null;
  try {
    offer = active ? offersService.assignOfferToUser(ctx.userId) : (offersService.releaseUserOffer(ctx.userId), null);
  } catch (e) {
    logger.error("Erreur d'assignation d'offre", { error: e.message, userId: ctx.userId });
  }

  ctx.res.json(200, { status: result.status, expiryAt: result.expiryAt, autoRenewing: result.autoRenewing, offer });
});

router.get("/status", authenticate, async ctx => {
  const row = db.get().prepare("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY verified_at DESC LIMIT 1").get(ctx.userId);
  const user = db.get().prepare("SELECT subscribed, role FROM users WHERE id = ?").get(ctx.userId);
  ctx.res.json(200, {
    subscribed: !!user.subscribed,
    role: user.role,
    lastVerification: row ? { status: row.status, expiryAt: row.expiry_at, verifiedAt: row.verified_at } : null,
    offer: offersService.getUserCurrentOffer(ctx.userId)
  });
});

module.exports = router;
