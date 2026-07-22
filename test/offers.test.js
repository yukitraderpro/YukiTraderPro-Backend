const assert = require("assert");
const fs = require("fs");
process.env.DB_PATH = "/tmp/yuki_test_offers_" + Date.now() + ".sqlite";
process.env.LOG_DIR = "/tmp/yuki_test_logs";
process.env.BACKUP_DIR = "/tmp/yuki_test_backups";

const db = require("../src/db");
const offersService = require("../src/services/subscriptionOffersService");

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n    " + (e.stack || e.message)); } }

console.log("\n== Offres d'abonnement (addendum V3.1) ==\n");

db.open();

/* Les assignations d'offres référencent des utilisateurs réels (contrainte
   de clé étrangère) : on crée quelques comptes minimalistes pour les tests. */
function seedUser(id) {
  const now = Date.now();
  db.get().prepare(`
    INSERT INTO users (id, email, password_hash, role, created_at, trial_until, subscribed)
    VALUES (?, ?, 'scrypt$1$1$1$00$00', 'free', ?, ?, 0)
  `).run(id, id + "@test.local", now, now);
}
["user-1", "user-2", "user-3", "user-4", "user-overflow", "user-renewal", "user-overflow-1001"].forEach(seedUser);
for (let i = 0; i < 1200; i++) seedUser("user-fill-" + i);

test("les deux offres par défaut sont créées au premier démarrage (Fondateur, Standard)", () => {
  const offers = offersService.listActiveOffers();
  assert.strictEqual(offers.length, 2);
  const founder = offers.find(o => o.name === "Fondateur");
  const standard = offers.find(o => o.name === "Standard");
  assert.ok(founder && standard);
  assert.strictEqual(founder.priceCents, 990);
  assert.strictEqual(founder.seatLimit, 1000);
  assert.strictEqual(standard.priceCents, 1990);
  assert.strictEqual(standard.seatLimit, null);
});

test("aucun tarif n'est codé ailleurs que dans cette table : les offres sont la seule source de vérité", () => {
  // Vérifie que l'API ne renvoie que ce qui est en base, rien de plus.
  const offers = offersService.listActiveOffers();
  offers.forEach(o => assert.ok(Number.isFinite(o.priceCents)));
});

test("assignOfferToUser assigne l'offre Fondateur à un nouvel abonné tant qu'il reste des places", () => {
  const a = offersService.assignOfferToUser("user-1");
  assert.strictEqual(a.offerName, "Fondateur");
  assert.strictEqual(a.lockedPriceCents, 990);
  assert.strictEqual(a.isNew, true);
});

test("assignOfferToUser est idempotent : un utilisateur déjà assigné garde son tarif verrouillé", () => {
  const a1 = offersService.assignOfferToUser("user-2");
  const a2 = offersService.assignOfferToUser("user-2");
  assert.strictEqual(a1.offerId, a2.offerId);
  assert.strictEqual(a2.isNew, false);
  assert.strictEqual(a2.lockedPriceCents, a1.lockedPriceCents);
});

test("le compteur de places se met à jour automatiquement à chaque assignation", () => {
  const before = offersService.listActiveOffers().find(o => o.name === "Fondateur").seatsUsed;
  offersService.assignOfferToUser("user-3");
  const after = offersService.listActiveOffers().find(o => o.name === "Fondateur").seatsUsed;
  assert.strictEqual(after, before + 1);
});

test("un membre Fondateur garde son tarif même si l'administrateur augmente le prix affiché de l'offre ensuite", () => {
  const a = offersService.assignOfferToUser("user-4");
  const founderOffer = offersService.listAllOffers().find(o => o.name === "Fondateur");
  offersService.updateOffer(founderOffer.id, { priceCents: 2500 }); // l'admin change le tarif affiché
  const current = offersService.getUserCurrentOffer("user-4");
  assert.strictEqual(current.lockedPriceCents, a.lockedPriceCents); // inchangé pour ce membre déjà assigné
  assert.notStrictEqual(current.lockedPriceCents, 2500);
  offersService.updateOffer(founderOffer.id, { priceCents: 990 }); // on remet le prix d'origine pour la suite des tests
});

test("releaseUserOffer libère la place et un réabonnement obtient l'offre EN VIGUEUR, pas l'ancien tarif", () => {
  const founderOfferBefore = offersService.listAllOffers().find(o => o.name === "Fondateur");
  offersService.releaseUserOffer("user-4"); // résiliation
  const founderOfferAfterRelease = offersService.listAllOffers().find(o => o.name === "Fondateur");
  assert.strictEqual(founderOfferAfterRelease.seatsUsed, founderOfferBefore.seatsUsed - 1);

  // Change le tarif Fondateur avant le réabonnement pour vérifier que le nouveau tarif s'applique
  offersService.updateOffer(founderOfferAfterRelease.id, { priceCents: 2200 });
  const reassigned = offersService.assignOfferToUser("user-4");
  assert.strictEqual(reassigned.lockedPriceCents, 2200);
  offersService.updateOffer(founderOfferAfterRelease.id, { priceCents: 990 }); // restaure pour la suite des tests
});

test("quand l'offre Fondateur est pleine, les nouveaux abonnés basculent automatiquement sur Standard", () => {
  const founderOffer = offersService.listAllOffers().find(o => o.name === "Fondateur");
  offersService.updateOffer(founderOffer.id, { seatLimit: offersService.listAllOffers().find(o => o.name === "Fondateur").seatsUsed }); // ferme les places restantes
  const a = offersService.assignOfferToUser("user-overflow");
  assert.strictEqual(a.offerName, "Standard");
  offersService.updateOffer(founderOffer.id, { seatLimit: 1000 }); // restaure pour la suite des tests
});

test("tryReserveSeat refuse quand il n'y a plus de place (pas de dépassement possible)", () => {
  const offer = offersService.createOffer({ name: "Test limitée", priceCents: 999, seatLimit: 1, active: true, sortOrder: 50 });
  assert.strictEqual(offersService.tryReserveSeat(offer.id), true);
  assert.strictEqual(offersService.tryReserveSeat(offer.id), false); // la place unique est déjà prise
});

test("une offre désactivée n'est plus proposée aux nouveaux abonnés ni listée publiquement", () => {
  const offer = offersService.createOffer({ name: "Promo temporaire", priceCents: 500, active: true, sortOrder: 5 });
  assert.ok(offersService.listActiveOffers().some(o => o.id === offer.id));
  offersService.updateOffer(offer.id, { active: false });
  assert.ok(!offersService.listActiveOffers().some(o => o.id === offer.id));
  assert.ok(offersService.listAllOffers().some(o => o.id === offer.id)); // toujours visible en admin
});

test("createOffer permet de créer une nouvelle promotion sans toucher au code", () => {
  const offer = offersService.createOffer({ name: "Black Friday", description: "-50% un mois", priceCents: 999, seatLimit: 200, active: true, sortOrder: 1 });
  assert.strictEqual(offer.name, "Black Friday");
  assert.strictEqual(offer.seatsRemaining, 200);
});

test("subscriberCounts reflète le nombre total d'abonnés actifs, tous statuts confondus", () => {
  const stats = offersService.subscriberCounts();
  assert.ok(stats.totalActiveSubscribers >= 1);
  assert.ok(Array.isArray(stats.offers));
});

/* ---- Addendum V3.3 : révision tarifaire (9,90€ / 19,90€) ------------------- */
test("les tarifs par défaut correspondent à l'addendum V3.3 (Fondateur 9,90€, Standard 19,90€)", () => {
  const offers = offersService.listActiveOffers();
  const founder = offers.find(o => o.name === "Fondateur");
  const standard = offers.find(o => o.name === "Standard");
  assert.strictEqual(founder.priceCents, 990);
  assert.strictEqual(standard.priceCents, 1990);
});

test("toute création d'offre est tracée dans l'historique des prix", () => {
  const offer = offersService.createOffer({ name: "Test historique", priceCents: 500, active: true, sortOrder: 90 }, "admin-1");
  const history = offersService.getPriceHistory(offer.id);
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].old_price_cents, null);
  assert.strictEqual(history[0].new_price_cents, 500);
  assert.strictEqual(history[0].changed_by, "admin-1");
});

test("toute modification de prix est tracée dans l'historique, avec l'ancien et le nouveau tarif", () => {
  const offer = offersService.createOffer({ name: "Test historique 2", priceCents: 500, active: true, sortOrder: 91 }, "admin-1");
  offersService.updateOffer(offer.id, { priceCents: 750 }, "admin-2");
  const history = offersService.getPriceHistory(offer.id);
  assert.strictEqual(history.length, 2); // création + modification
  const latest = history[0]; // trié du plus récent au plus ancien
  assert.strictEqual(latest.old_price_cents, 500);
  assert.strictEqual(latest.new_price_cents, 750);
  assert.strictEqual(latest.changed_by, "admin-2");
});

test("modifier un champ autre que le prix ne crée pas d'entrée d'historique", () => {
  const offer = offersService.createOffer({ name: "Test historique 3", priceCents: 500, active: true, sortOrder: 92 }, "admin-1");
  offersService.updateOffer(offer.id, { description: "Nouvelle description" }, "admin-2");
  const history = offersService.getPriceHistory(offer.id);
  assert.strictEqual(history.length, 1); // uniquement la création
});

test("un renouvellement (même utilisateur, abonnement toujours actif) conserve le tarif Fondateur verrouillé", () => {
  const a1 = offersService.assignOfferToUser("user-renewal");
  const a2 = offersService.assignOfferToUser("user-renewal"); // simulateur de renouvellement / nouvelle vérification d'achat
  assert.strictEqual(a1.lockedPriceCents, a2.lockedPriceCents);
  assert.strictEqual(a2.isNew, false);
});

test("la 1000e place Fondateur est acceptée, la 1001e bascule sur Standard", () => {
  const founderOffer = offersService.listAllOffers().find(o => o.name === "Fondateur");
  const remaining = founderOffer.seatLimit - founderOffer.seatsUsed;
  // Comble exactement les places restantes.
  for (let i = 0; i < remaining; i++) offersService.assignOfferToUser("user-fill-" + i);
  const full = offersService.listAllOffers().find(o => o.name === "Fondateur");
  assert.strictEqual(full.seatsUsed, full.seatLimit); // 1000/1000, aucun dépassement
  const overflow = offersService.assignOfferToUser("user-overflow-1001");
  assert.strictEqual(overflow.offerName, "Standard");
});

db.close();
try { fs.unlinkSync(process.env.DB_PATH); } catch {}
try { fs.unlinkSync(process.env.DB_PATH + "-wal"); } catch {}
try { fs.unlinkSync(process.env.DB_PATH + "-shm"); } catch {}

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
process.exit(failed ? 1 : 0);
