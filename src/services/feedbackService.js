/* ==========================================================================
   BACKEND_17 — RETOURS (demande Simon 11/10/2026)
   --------------------------------------------------------------------------
   Deux questionnaires, chacun posé UNE fois par compte :
   · « trial » — comptes créés mais non abonnés, l'essai terminé : pourquoi ?
     Cases à cocher (REASONS), note sur 5, commentaire libre ; « plus tard »
     (redemandé 7 jours après, deux fois au plus) ou « ne plus demander ».
   · « subscriber » — abonnés depuis un moment : une note et un commentaire,
     avec l'invitation à les déposer sur Google Play.
   Chaque questionnaire : une carte dans l'application + UN courrier par compte
   (voir mailService), désactivé tant que FEEDBACK_EMAIL_ENABLED n'est pas "true".
   Les réponses sont privées (vue admin). L'invitation à laisser un avis sur
   Google Play est proposée à TOUT répondant, quelle que soit sa note : filtrer
   les mécontents (« review gating ») est interdit par les règles de Google.
   Une ligne par (compte, questionnaire) : un essai devenu abonné garde sa
   réponse d'essai et reçoit le second questionnaire.
   ========================================================================== */
const REASONS = ["price", "unclear", "not_convinced", "no_time", "other_tool", "not_trading", "other"];
const KINDS = ["trial", "subscriber"];

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS trial_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'trial', -- trial | subscriber
    status TEXT NOT NULL,            -- answered | later | never
    reasons TEXT,                    -- JSON : codes parmi REASONS (trial seulement)
    rating INTEGER,                  -- 1..5, facultatif
    comment TEXT,
    later_count INTEGER NOT NULL DEFAULT 0,
    next_ask_at INTEGER,
    email_sent_at INTEGER,
    opened_play INTEGER NOT NULL DEFAULT 0, -- a ouvert Google Play depuis la carte
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(user_id, kind)
  )`);
}

function createFeedback({ getDb, mail, config, now = () => Date.now(), logger }) {
  let ready = false;
  const db = () => { const d = getDb(); if (!ready) { ensureSchema(d); ready = true; } return d; };
  const log = logger || { info() {}, warn() {}, error() {} };
  const DAY = 86400000;

  function userRow(userId) { return db().prepare("SELECT id, email, role, created_at, trial_until, subscribed FROM users WHERE id = ?").get(userId) || null; }
  function isSubscriber(u) { return u.role === "pro" || !!u.subscribed; }
  /* Quel questionnaire pour ce compte ? trial = pas abonné après l'essai ; subscriber = abonné depuis un moment ; null = aucun (admin, compte trop récent). */
  function kindFor(u) {
    if (!u || u.role === "admin") return null;
    const age = now() - u.created_at;
    if (isSubscriber(u)) return age >= config.askSubscriberAfterDays * DAY ? "subscriber" : null;
    if (u.role === "free") return age >= config.askInAppAfterDays * DAY ? "trial" : null;
    return null;
  }
  function rowFor(userId, kind) { return db().prepare("SELECT * FROM trial_feedback WHERE user_id = ? AND kind = ?").get(userId, kind) || null; }

  /* Faut-il poser la question dans l'application ? */
  function eligibility(userId) {
    const u = userRow(userId), kind = kindFor(u);
    if (!kind) return { ask: false, reason: "not_eligible" };
    const row = rowFor(userId, kind);
    if (!row) return { ask: true, kind };
    if (row.status === "answered" || row.status === "never") return { ask: false, reason: row.status, kind };
    if (row.later_count >= 2) return { ask: false, reason: "asked_enough", kind };
    return now() >= (row.next_ask_at || 0) ? { ask: true, kind } : { ask: false, reason: "later", kind };
  }

  function record(userId, body) {
    const u = userRow(userId); if (!u) throw new Error("compte inconnu");
    const kind = kindFor(u) || (isSubscriber(u) ? "subscriber" : "trial");
    const t = now();
    const existing = rowFor(userId, kind);
    if (body.action === "later") {
      const count = (existing ? existing.later_count : 0) + 1;
      db().prepare(`INSERT INTO trial_feedback (user_id, kind, status, later_count, next_ask_at, created_at, updated_at) VALUES (?, ?, 'later', ?, ?, ?, ?)
        ON CONFLICT(user_id, kind) DO UPDATE SET status = 'later', later_count = ?, next_ask_at = ?, updated_at = ?`).run(userId, kind, count, t + 7 * DAY, t, t, count, t + 7 * DAY, t);
      return { recorded: true, status: "later", kind };
    }
    if (body.action === "never") {
      db().prepare(`INSERT INTO trial_feedback (user_id, kind, status, created_at, updated_at) VALUES (?, ?, 'never', ?, ?)
        ON CONFLICT(user_id, kind) DO UPDATE SET status = 'never', updated_at = ?`).run(userId, kind, t, t, t);
      return { recorded: true, status: "never", kind };
    }
    const reasons = kind === "trial" && Array.isArray(body.reasons) ? [...new Set(body.reasons.filter(r => REASONS.includes(r)))] : [];
    const rating = Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5 ? body.rating : null;
    const comment = String(body.comment || "").trim().slice(0, 1000) || null;
    const openedPlay = body.openedPlay === true ? 1 : 0;
    if (!reasons.length && rating === null && !comment && !openedPlay) throw new Error("réponse vide");
    /* Un complément (ouverture de Google Play après l'envoi, note ajoutée) ne remplace jamais ce qui a déjà été dit. */
    const reasonsJson = reasons.length ? JSON.stringify(reasons) : null;
    db().prepare(`INSERT INTO trial_feedback (user_id, kind, status, reasons, rating, comment, opened_play, created_at, updated_at) VALUES (?, ?, 'answered', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, kind) DO UPDATE SET status = 'answered', reasons = COALESCE(?, reasons), rating = COALESCE(?, rating), comment = COALESCE(?, comment), opened_play = MAX(opened_play, ?), updated_at = ?`)
      .run(userId, kind, reasonsJson || "[]", rating, comment, openedPlay, t, t, reasonsJson, rating, comment, openedPlay, t);
    return { recorded: true, status: "answered", kind };
  }

  /* Vue admin : par questionnaire, liste + comptage par raison + note moyenne. */
  function summary() {
    const rows = db().prepare(`SELECT f.*, u.email, u.created_at AS account_created_at FROM trial_feedback f JOIN users u ON u.id = f.user_id ORDER BY f.updated_at DESC`).all();
    const part = kind => {
      const mine = rows.filter(r => r.kind === kind), answered = mine.filter(r => r.status === "answered");
      const counts = {}; for (const r of REASONS) counts[r] = 0;
      let ratingSum = 0, ratingN = 0;
      for (const r of answered) { for (const k of JSON.parse(r.reasons || "[]")) counts[k] = (counts[k] || 0) + 1; if (r.rating) { ratingSum += r.rating; ratingN++; } }
      return { answered: answered.length, later: mine.filter(r => r.status === "later").length, never: mine.filter(r => r.status === "never").length,
        emailsSent: mine.filter(r => r.email_sent_at).length, openedPlay: mine.filter(r => r.opened_play).length, counts, avgRating: ratingN ? Math.round(ratingSum / ratingN * 10) / 10 : null, ratings: ratingN,
        list: answered.slice(0, 200).map(r => ({ email: r.email, reasons: JSON.parse(r.reasons || "[]"), rating: r.rating, comment: r.comment, openedPlay: !!r.opened_play, at: r.updated_at, accountCreatedAt: r.account_created_at })) };
    };
    const t = now();
    return {
      trial: { eligible: db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'free' AND subscribed = 0 AND created_at <= ?").get(t - config.askInAppAfterDays * DAY).n, ...part("trial") },
      subscriber: { eligible: db().prepare("SELECT COUNT(*) AS n FROM users WHERE (role = 'pro' OR subscribed = 1) AND role <> 'admin' AND created_at <= ?").get(t - config.askSubscriberAfterDays * DAY).n, ...part("subscriber") }
    };
  }

  /* Courriers : UN par compte et par questionnaire, jamais à ceux qui ont déjà répondu ou dit « ne plus demander ». */
  function dueEmails(limit) {
    const t0 = now();
    const trial = db().prepare(`SELECT u.id, u.email, 'trial' AS kind FROM users u LEFT JOIN trial_feedback f ON f.user_id = u.id AND f.kind = 'trial'
      WHERE u.role = 'free' AND u.subscribed = 0 AND u.created_at <= ? AND (f.user_id IS NULL OR (f.email_sent_at IS NULL AND f.status NOT IN ('answered','never'))) LIMIT ?`).all(t0 - config.afterDays * DAY, limit);
    const subscriber = db().prepare(`SELECT u.id, u.email, 'subscriber' AS kind FROM users u LEFT JOIN trial_feedback f ON f.user_id = u.id AND f.kind = 'subscriber'
      WHERE (u.role = 'pro' OR u.subscribed = 1) AND u.role <> 'admin' AND u.created_at <= ? AND (f.user_id IS NULL OR (f.email_sent_at IS NULL AND f.status NOT IN ('answered','never'))) LIMIT ?`).all(t0 - config.askSubscriberAfterDays * DAY, limit);
    return [...trial, ...subscriber];
  }

  async function sendDueEmails(limit = 50) {
    if (!config.emailEnabled) return { enabled: false, sent: 0 };
    const due = dueEmails(limit);
    let sent = 0, failed = 0;
    const url = config.appPublicUrl + "/?feedback=1";
    for (const u of due) {
      const r = u.kind === "trial" ? await mail.sendTrialFeedback(u.email, url) : await mail.sendSubscriberReview(u.email, url, config.playStoreUrl);
      const t = now();
      if (r.sent) { sent++; db().prepare(`INSERT INTO trial_feedback (user_id, kind, status, email_sent_at, created_at, updated_at) VALUES (?, ?, 'later', ?, ?, ?)
        ON CONFLICT(user_id, kind) DO UPDATE SET email_sent_at = ?, updated_at = ?`).run(u.id, u.kind, t, t, t, t, t); }
      else { failed++; if (r.reason === "not_configured") break; }
    }
    if (due.length) log.info("[feedback] courriers envoyés", { due: due.length, sent, failed });
    return { enabled: true, due: due.length, sent, failed };
  }

  function schedule(intervalMs = 6 * 60 * 60 * 1000) {
    const timer = setInterval(() => { sendDueEmails().catch(e => log.error("[feedback] envoi en échec", { error: e.message })); }, intervalMs);
    if (timer.unref) timer.unref();
    const first = setTimeout(() => { sendDueEmails().catch(() => {}); }, 60 * 1000); if (first.unref) first.unref();
    return timer;
  }

  return { eligibility, kindFor, record, summary, dueEmails, sendDueEmails, schedule, REASONS, KINDS };
}

module.exports = { createFeedback, ensureSchema, REASONS, KINDS };
