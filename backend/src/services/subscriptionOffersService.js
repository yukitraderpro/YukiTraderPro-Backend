/* ==========================================================================
   Service des offres d'abonnement — addendum V3.1 « Abonnements »
   --------------------------------------------------------------------------
   Principe : AUCUN tarif n'est codé en dur dans l'application cliente. Tout
   est piloté depuis cette table (`subscription_offers`), modifiable à chaud
   via les routes d'administration, sans jamais republier l'application.

   Règles métier implémentées ici (comme demandé dans l'addendum) :
   - Le compteur de places restantes se met à jour automatiquement, de façon
     atomique (une requête SQL conditionnelle, pas de lecture-puis-écriture
     qui pourrait laisser passer deux abonnés sur la dernière place en cas
     de requêtes simultanées).
   - Un membre déjà assigné à une offre (ex. Fondateur) garde SON tarif
     verrouillé (`locked_price_cents`) tant que son abonnement reste actif,
     même si l'administrateur change le prix affiché de l'offre ensuite.
   - À la résiliation (abonnement qui n'est plus actif), sa place est
     libérée : un réabonnement ultérieur obtient l'offre EN VIGUEUR à ce
     moment-là, pas l'ancien tarif.
   ========================================================================== */
const crypto = require("crypto");
const db = require("../db");

function newId() { return crypto.randomUUID(); }

function toPublicOffer(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    currency: row.currency,
    seatLimit: row.seat_limit,
    seatsUsed: row.seats_used,
    seatsRemaining: row.seat_limit === null ? null : Math.max(0, row.seat_limit - row.seats_used),
    active: !!row.active,
    sortOrder: row.sort_order
  };
}

function listActiveOffers() {
  const rows = db.get().prepare("SELECT * FROM subscription_offers WHERE active = 1 ORDER BY sort_order ASC").all();
  return rows.map(toPublicOffer);
}

function listAllOffers() {
  const rows = db.get().prepare("SELECT * FROM subscription_offers ORDER BY sort_order ASC").all();
  return rows.map(toPublicOffer);
}

function logPriceChange(offerId, offerName, oldPriceCents, newPriceCents, changedBy) {
  db.get().prepare(`
    INSERT INTO offer_price_history (id, offer_id, offer_name, old_price_cents, new_price_cents, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId(), offerId, offerName, oldPriceCents, newPriceCents, changedBy || "unknown", Date.now());
}

function getPriceHistory(offerId) {
  return db.get().prepare("SELECT * FROM offer_price_history WHERE offer_id = ? ORDER BY changed_at DESC").all(offerId);
}

function createOffer({ name, description, priceCents, seatLimit, active, sortOrder }, changedBy) {
  if (!name || !Number.isFinite(priceCents) || priceCents < 0) throw new Error("Nom et prix (en centimes) requis.");
  const conn = db.get();
  const now = Date.now();
  const id = newId();
  conn.prepare(`
    INSERT INTO subscription_offers (id, name, description, price_cents, currency, seat_limit, seats_used, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'EUR', ?, 0, ?, ?, ?, ?)
  `).run(id, name, description || null, Math.round(priceCents), Number.isFinite(seatLimit) ? seatLimit : null, active === false ? 0 : 1, Number.isFinite(sortOrder) ? sortOrder : 99, now, now);
  logPriceChange(id, name, null, Math.round(priceCents), changedBy);
  return toPublicOffer(conn.prepare("SELECT * FROM subscription_offers WHERE id = ?").get(id));
}

function updateOffer(id, patch, changedBy) {
  const conn = db.get();
  const row = conn.prepare("SELECT * FROM subscription_offers WHERE id = ?").get(id);
  if (!row) throw new Error("Offre introuvable.");
  const next = {
    name: patch.name !== undefined ? patch.name : row.name,
    description: patch.description !== undefined ? patch.description : row.description,
    price_cents: patch.priceCents !== undefined ? Math.round(patch.priceCents) : row.price_cents,
    seat_limit: patch.seatLimit !== undefined ? (patch.seatLimit === null ? null : Math.round(patch.seatLimit)) : row.seat_limit,
    active: patch.active !== undefined ? (patch.active ? 1 : 0) : row.active,
    sort_order: patch.sortOrder !== undefined ? patch.sortOrder : row.sort_order
  };
  conn.prepare(`
    UPDATE subscription_offers SET name=?, description=?, price_cents=?, seat_limit=?, active=?, sort_order=?, updated_at=?
    WHERE id=?
  `).run(next.name, next.description, next.price_cents, next.seat_limit, next.active, next.sort_order, Date.now(), id);
  if (next.price_cents !== row.price_cents) logPriceChange(id, next.name, row.price_cents, next.price_cents, changedBy);
  return toPublicOffer(conn.prepare("SELECT * FROM subscription_offers WHERE id = ?").get(id));
}

/* Tente d'occuper une place sur `offerId` de façon atomique. Renvoie true si
   la place a bien été prise, false si elle n'était plus disponible (course
   avec un autre abonné, ou offre désactivée entre-temps). */
function tryReserveSeat(offerId) {
  const conn = db.get();
  const result = conn.prepare(`
    UPDATE subscription_offers
    SET seats_used = seats_used + 1, updated_at = ?
    WHERE id = ? AND active = 1 AND (seat_limit IS NULL OR seats_used < seat_limit)
  `).run(Date.now(), offerId);
  return result.changes > 0;
}

function releaseSeat(offerId) {
  db.get().prepare(`
    UPDATE subscription_offers SET seats_used = MAX(0, seats_used - 1), updated_at = ? WHERE id = ?
  `).run(Date.now(), offerId);
}

function getActiveAssignment(userId) {
  return db.get().prepare(`
    SELECT a.*, o.name AS offer_name, o.currency AS currency
    FROM user_offer_assignments a JOIN subscription_offers o ON o.id = a.offer_id
    WHERE a.user_id = ? AND a.released_at IS NULL
    ORDER BY a.assigned_at DESC LIMIT 1
  `).get(userId);
}

/* Assigne (ou confirme) l'offre d'un utilisateur qui vient d'être vérifié
   comme abonné actif. Idempotent : si l'utilisateur a déjà une assignation
   active, elle est renvoyée telle quelle (son tarif verrouillé ne change
   jamais tant qu'il reste actif). Sinon, essaie les offres actives dans
   l'ordre (`sort_order`) jusqu'à en trouver une avec une place disponible —
   la boucle gère la course où une offre limitée se remplit entre la lecture
   et l'écriture. */
function assignOfferToUser(userId) {
  const existing = getActiveAssignment(userId);
  if (existing) return { offerId: existing.offer_id, offerName: existing.offer_name, lockedPriceCents: existing.locked_price_cents, currency: existing.currency, isNew: false };

  const conn = db.get();
  const candidates = conn.prepare("SELECT * FROM subscription_offers WHERE active = 1 ORDER BY sort_order ASC").all();
  for (const offer of candidates) {
    if (tryReserveSeat(offer.id)) {
      const now = Date.now();
      const id = newId();
      conn.prepare(`
        INSERT INTO user_offer_assignments (id, user_id, offer_id, locked_price_cents, assigned_at, released_at)
        VALUES (?, ?, ?, ?, ?, NULL)
      `).run(id, userId, offer.id, offer.price_cents, now);
      return { offerId: offer.id, offerName: offer.name, lockedPriceCents: offer.price_cents, currency: offer.currency, isNew: true };
    }
  }
  throw new Error("Aucune offre disponible actuellement.");
}

/* Libère la place d'un utilisateur dont l'abonnement n'est plus actif
   (résilié, expiré). Un futur réabonnement passera par `assignOfferToUser`
   et obtiendra l'offre en vigueur à ce moment — jamais l'ancien tarif. */
function releaseUserOffer(userId) {
  const existing = getActiveAssignment(userId);
  if (!existing) return null;
  db.get().prepare("UPDATE user_offer_assignments SET released_at = ? WHERE id = ?").run(Date.now(), existing.id);
  releaseSeat(existing.offer_id);
  return existing;
}

function getUserCurrentOffer(userId) {
  const a = getActiveAssignment(userId);
  if (!a) return null;
  return { offerId: a.offer_id, offerName: a.offer_name, lockedPriceCents: a.locked_price_cents, currency: a.currency, assignedAt: a.assigned_at };
}

function subscriberCounts() {
  const offers = listAllOffers();
  const totalActive = db.get().prepare("SELECT COUNT(*) AS n FROM user_offer_assignments WHERE released_at IS NULL").get().n;
  return { offers, totalActiveSubscribers: totalActive };
}

module.exports = {
  listActiveOffers, listAllOffers, createOffer, updateOffer,
  assignOfferToUser, releaseUserOffer, getUserCurrentOffer, subscriberCounts,
  getPriceHistory,
  tryReserveSeat, releaseSeat // exportés pour les tests
};
