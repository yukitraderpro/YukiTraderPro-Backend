/* BACKEND_17 — retours : qui est interrogé, quand, une seule fois ; réponse,
   « plus tard », « ne plus demander » ; vue admin ; courrier unique par compte
   et par questionnaire ; abonnés invités à noter sur Google Play SANS filtrage. */
const test = require("node:test");
const assert = require("node:assert");
const db = require("../src/db");
const { createFeedback, REASONS } = require("../src/services/feedbackService");
const { trialFeedbackTemplate, subscriberReviewTemplate } = require("../src/services/mailService");

const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
const CFG = { emailEnabled: true, afterDays: 8, askInAppAfterDays: 7, askSubscriberAfterDays: 14, appPublicUrl: "https://www.yukitraderpro.com", playStoreUrl: "https://play.google.com/store/apps/details?id=com.yukitraderpro.app" };

function fakeMail() {
  const sent = [];
  return { sent, sendTrialFeedback: async (email, url) => { sent.push({ kind: "trial", email, url }); return { sent: true }; },
    sendSubscriberReview: async (email, url, play) => { sent.push({ kind: "subscriber", email, url, play }); return { sent: true }; } };
}
function addUser(id, { role = "free", ageDays = 10, subscribed = 0 }) {
  db.get().prepare("INSERT INTO users (id, email, password_hash, role, created_at, trial_until, subscribed) VALUES (?, ?, 'x', ?, ?, ?, ?)")
    .run(id, id + "@test.fr", role, T0 - ageDays * DAY, T0 - ageDays * DAY + 7 * DAY, subscribed);
}

test("ÉLIGIBILITÉ — non abonné après 7 jours → questionnaire d'essai ; abonné après 14 jours → note Google Play ; admin et comptes récents : rien", () => {
  db.open(":memory:");
  let now = T0;
  const f = createFeedback({ getDb: () => db.get(), mail: fakeMail(), config: CFG, now: () => now });
  addUser("free_old", { ageDays: 10 }); addUser("free_new", { ageDays: 2 });
  addUser("pro_old", { role: "pro", ageDays: 20, subscribed: 1 }); addUser("pro_new", { role: "pro", ageDays: 5, subscribed: 1 });
  addUser("adm", { role: "admin", ageDays: 400 }); addUser("sub_flag", { role: "free", ageDays: 30, subscribed: 1 });
  assert.deepStrictEqual(f.eligibility("free_old"), { ask: true, kind: "trial" });
  assert.deepStrictEqual(f.eligibility("free_new"), { ask: false, reason: "not_eligible" });
  assert.deepStrictEqual(f.eligibility("pro_old"), { ask: true, kind: "subscriber" });
  assert.deepStrictEqual(f.eligibility("pro_new"), { ask: false, reason: "not_eligible" });
  assert.deepStrictEqual(f.eligibility("adm"), { ask: false, reason: "not_eligible" });
  assert.deepStrictEqual(f.eligibility("sub_flag"), { ask: true, kind: "subscriber" }, "subscribed=1 compte comme abonné même si role=free");
  assert.deepStrictEqual(f.eligibility("inconnu"), { ask: false, reason: "not_eligible" });
});

test("RÉPONSE — cases à cocher filtrées, note bornée, commentaire tronqué ; une réponse clôt la question ; vide refusé", () => {
  db.open(":memory:");
  let now = T0;
  const f = createFeedback({ getDb: () => db.get(), mail: fakeMail(), config: CFG, now: () => now });
  addUser("u1", { ageDays: 10 });
  assert.throws(() => f.record("u1", {}), /réponse vide/);
  assert.throws(() => f.record("u1", { reasons: ["bidon"], rating: 9, comment: "   " }), /réponse vide/, "raisons inconnues et note hors bornes → rien à enregistrer");
  assert.throws(() => f.record("zz", { rating: 3 }), /compte inconnu/);
  const r = f.record("u1", { reasons: ["price", "price", "unclear", "bidon"], rating: 3, comment: " trop cher ".padEnd(2000, "x") });
  assert.deepStrictEqual(r, { recorded: true, status: "answered", kind: "trial" });
  assert.deepStrictEqual(f.eligibility("u1"), { ask: false, reason: "answered", kind: "trial" });
  const s = f.summary();
  assert.strictEqual(s.trial.answered, 1); assert.strictEqual(s.trial.eligible, 1);
  assert.deepStrictEqual(s.trial.list[0].reasons, ["price", "unclear"]);
  assert.strictEqual(s.trial.list[0].rating, 3); assert.strictEqual(s.trial.list[0].comment.length, 1000);
  assert.strictEqual(s.trial.list[0].email, "u1@test.fr");
  assert.strictEqual(s.trial.counts.price, 1); assert.strictEqual(s.trial.counts.unclear, 1); assert.strictEqual(s.trial.counts.other, 0);
  assert.strictEqual(s.trial.avgRating, 3);
  for (const k of REASONS) assert.ok(k in s.trial.counts);
  /* après l'envoi, l'utilisateur ouvre Google Play : ses raisons et sa note restent */
  f.record("u1", { openedPlay: true });
  const l = f.summary().trial.list[0];
  assert.deepStrictEqual(l.reasons, ["price", "unclear"]); assert.strictEqual(l.rating, 3); assert.strictEqual(l.openedPlay, true);
  assert.strictEqual(f.summary().trial.openedPlay, 1);
});

test("PLUS TARD / NE PLUS DEMANDER — « plus tard » repose la question 7 jours après, deux fois au plus ; « jamais » clôt", () => {
  db.open(":memory:");
  let now = T0;
  const f = createFeedback({ getDb: () => db.get(), mail: fakeMail(), config: CFG, now: () => now });
  addUser("u1", { ageDays: 10 }); addUser("u2", { ageDays: 10 });
  assert.deepStrictEqual(f.record("u1", { action: "later" }), { recorded: true, status: "later", kind: "trial" });
  assert.deepStrictEqual(f.eligibility("u1"), { ask: false, reason: "later", kind: "trial" });
  now = T0 + 6 * DAY; assert.strictEqual(f.eligibility("u1").ask, false, "pas avant 7 jours");
  now = T0 + 7 * DAY; assert.strictEqual(f.eligibility("u1").ask, true, "redemandé à 7 jours");
  f.record("u1", { action: "later" });
  now = T0 + 14 * DAY; assert.deepStrictEqual(f.eligibility("u1"), { ask: false, reason: "asked_enough", kind: "trial" }, "deux « plus tard » : on n'insiste plus");
  assert.deepStrictEqual(f.record("u2", { action: "never" }), { recorded: true, status: "never", kind: "trial" });
  assert.deepStrictEqual(f.eligibility("u2"), { ask: false, reason: "never", kind: "trial" });
  const s = f.summary(); assert.strictEqual(s.trial.later, 1); assert.strictEqual(s.trial.never, 1); assert.strictEqual(s.trial.answered, 0);
});

test("ABONNÉS — note + commentaire + ouverture de Google Play ; les cases à cocher d'essai ne s'appliquent pas ; aucun filtrage sur la note", () => {
  db.open(":memory:");
  let now = T0;
  const f = createFeedback({ getDb: () => db.get(), mail: fakeMail(), config: CFG, now: () => now });
  addUser("p1", { role: "pro", ageDays: 20, subscribed: 1 }); addUser("p2", { role: "pro", ageDays: 20, subscribed: 1 });
  assert.deepStrictEqual(f.record("p1", { reasons: ["price"], rating: 2, comment: "Bof", openedPlay: true }), { recorded: true, status: "answered", kind: "subscriber" });
  assert.deepStrictEqual(f.record("p2", { openedPlay: true }), { recorded: true, status: "answered", kind: "subscriber" }, "juste ouvrir Google Play compte comme réponse");
  const s = f.summary();
  assert.strictEqual(s.subscriber.answered, 2); assert.strictEqual(s.subscriber.openedPlay, 2); assert.strictEqual(s.subscriber.eligible, 2);
  assert.deepStrictEqual(s.subscriber.list.find(x => x.email === "p1@test.fr").reasons, [], "pas de raisons pour un abonné");
  assert.strictEqual(s.subscriber.list.find(x => x.email === "p1@test.fr").rating, 2, "une note de 2 est enregistrée et comptée comme les autres");
  assert.strictEqual(s.subscriber.avgRating, 2);
  /* un répondant complète ensuite sa réponse (commentaire puis ouverture de Play) : rien n'est perdu */
  f.record("p2", { rating: 5, comment: "Top" }); const l = f.summary().subscriber.list.find(x => x.email === "p2@test.fr");
  assert.strictEqual(l.openedPlay, true); assert.strictEqual(l.rating, 5); assert.strictEqual(l.comment, "Top");
});

test("ESSAI DEVENU ABONNÉ — la réponse d'essai est conservée et le second questionnaire est posé", () => {
  db.open(":memory:");
  let now = T0;
  const f = createFeedback({ getDb: () => db.get(), mail: fakeMail(), config: CFG, now: () => now });
  addUser("c1", { ageDays: 10 });
  f.record("c1", { reasons: ["no_time"], rating: 4 });
  db.get().prepare("UPDATE users SET role = 'pro', subscribed = 1 WHERE id = 'c1'").run();
  now = T0 + 10 * DAY; /* compte vieux de 20 jours, abonné */
  assert.deepStrictEqual(f.eligibility("c1"), { ask: true, kind: "subscriber" });
  f.record("c1", { rating: 5, comment: "Finalement convaincu", openedPlay: true });
  const s = f.summary();
  assert.strictEqual(s.trial.answered, 1); assert.deepStrictEqual(s.trial.list[0].reasons, ["no_time"]);
  assert.strictEqual(s.subscriber.answered, 1); assert.strictEqual(s.subscriber.list[0].comment, "Finalement convaincu");
});

test("COURRIERS — désactivés par défaut ; UN envoi par compte et par questionnaire, après 8 jours (essai) / 14 jours (abonné) ; jamais à ceux qui ont répondu ou refusé ; le courrier ne bloque pas la carte", async () => {
  db.open(":memory:");
  let now = T0;
  const off = createFeedback({ getDb: () => db.get(), mail: fakeMail(), config: { ...CFG, emailEnabled: false }, now: () => now });
  assert.deepStrictEqual(await off.sendDueEmails(), { enabled: false, sent: 0 });
  const mail = fakeMail();
  const f = createFeedback({ getDb: () => db.get(), mail, config: CFG, now: () => now });
  addUser("a", { ageDays: 9 });                      // essai fini, non abonné → courrier
  addUser("b", { ageDays: 7 });                      // carte oui (7 j), courrier pas encore (8 j)
  addUser("c", { ageDays: 30 });                     // a déjà répondu → pas de courrier
  addUser("d", { ageDays: 30 });                     // a dit « jamais » → pas de courrier
  addUser("e", { ageDays: 30, role: "pro", subscribed: 1 }); // abonné → courrier Google Play
  addUser("g", { ageDays: 10, role: "pro", subscribed: 1 }); // abonné trop récent
  addUser("adm", { role: "admin", ageDays: 400, subscribed: 1 });
  f.record("c", { rating: 1 }); f.record("d", { action: "never" });
  const r1 = await f.sendDueEmails();
  assert.deepStrictEqual(r1, { enabled: true, due: 2, sent: 2, failed: 0 });
  assert.deepStrictEqual(mail.sent.map(m => [m.kind, m.email]), [["trial", "a@test.fr"], ["subscriber", "e@test.fr"]]);
  assert.strictEqual(mail.sent[0].url, "https://www.yukitraderpro.com/?feedback=1");
  assert.strictEqual(mail.sent[1].play, CFG.playStoreUrl);
  assert.deepStrictEqual(await f.sendDueEmails(), { enabled: true, due: 0, sent: 0, failed: 0 }, "pas de second courrier");
  assert.deepStrictEqual(f.eligibility("a"), { ask: true, kind: "trial" }, "le courrier n'empêche pas la carte dans l'application");
  assert.deepStrictEqual(f.eligibility("e"), { ask: true, kind: "subscriber" });
  now = T0 + 2 * DAY; /* b atteint 9 jours */
  assert.deepStrictEqual(await f.sendDueEmails(), { enabled: true, due: 1, sent: 1, failed: 0 });
  assert.strictEqual(mail.sent[2].email, "b@test.fr");
  const s = f.summary(); assert.strictEqual(s.trial.emailsSent, 2); assert.strictEqual(s.subscriber.emailsSent, 1);
  /* « a » répond après le courrier : la ligne du courrier devient la réponse */
  f.record("a", { reasons: ["price"] }); assert.strictEqual(f.summary().trial.answered, 2); assert.strictEqual(f.summary().trial.emailsSent, 2);
  /* fournisseur non configuré : on s'arrête sans marquer d'envoi */
  addUser("h", { ageDays: 9 });
  const dead = createFeedback({ getDb: () => db.get(), mail: { sendTrialFeedback: async () => ({ sent: false, reason: "not_configured" }), sendSubscriberReview: async () => ({ sent: false, reason: "not_configured" }) }, config: CFG, now: () => now });
  assert.deepStrictEqual(await dead.sendDueEmails(), { enabled: true, due: 1, sent: 0, failed: 1 });
  assert.deepStrictEqual(await dead.sendDueEmails(), { enabled: true, due: 1, sent: 0, failed: 1 }, "toujours dû : rien n'a été marqué envoyé");
});

test("COURRIERS — textes : lien vers le questionnaire, promesse d'un seul message, Google Play pour les abonnés, jamais « conseil », « prédiction » ni « CFD »", () => {
  const t = trialFeedbackTemplate("https://www.yukitraderpro.com/?feedback=1");
  assert.match(t.text, /feedback=1/); assert.match(t.html, /href="https:\/\/www\.yukitraderpro\.com\/\?feedback=1"/);
  assert.match(t.text, /pas d'autre message/); assert.match(t.text, /jamais publiées/);
  const s = subscriberReviewTemplate("https://www.yukitraderpro.com/?feedback=1", "https://play.google.com/store/apps/details?id=com.yukitraderpro.app");
  assert.match(s.html, /href="https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.yukitraderpro\.app"/);
  assert.match(s.text, /bonne ou mauvaise/, "aucune incitation à ne noter que si content");
  for (const txt of [t.text, t.html, s.text, s.html]) { assert.doesNotMatch(txt, /conseil|prédiction|CFD|garanti/i); }
});
