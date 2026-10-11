/* ==========================================================================
   Envoi d'e-mails transactionnels (réinitialisation de mot de passe).
   --------------------------------------------------------------------------
   Fournisseur : Resend (https://resend.com) — API HTTP simple, offre gratuite
   de 3 000 e-mails/mois, suffisante pour démarrer. Aucune dépendance npm
   supplémentaire : on utilise fetch, disponible nativement depuis Node 18.

   Si RESEND_API_KEY n'est pas configuré, l'envoi est désactivé : la fonction
   renvoie { sent:false } au lieu de lever une erreur. Le flux de mot de passe
   oublié continue de répondre normalement à l'utilisateur (voir la note sur
   l'énumération de comptes dans routes/auth.js), et le lien est écrit dans les
   logs pour permettre le développement local sans compte Resend.
   ========================================================================== */
const config = require("../config");
const logger = require("../logger");

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function resetTemplate(resetUrl) {
  const safeUrl = escapeHtml(resetUrl);
  const text = [
    "Réinitialisation de votre mot de passe Yuki Trader Pro",
    "",
    "Vous avez demandé à réinitialiser votre mot de passe.",
    "Ouvrez le lien ci-dessous pour choisir un nouveau mot de passe :",
    "",
    resetUrl,
    "",
    "Ce lien est valable une heure et ne peut servir qu'une seule fois.",
    "",
    "Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail :",
    "votre mot de passe actuel reste inchangé.",
    "",
    "— L'équipe Yuki Trader Pro"
  ].join("\n");

  const html = `<!doctype html><html lang="fr"><body style="margin:0;padding:24px;background:#0f172a;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e2e8f0">
  <div style="max-width:520px;margin:0 auto;background:#1e293b;border-radius:12px;padding:32px">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;color:#38bdf8">YUKI TRADER PRO</p>
    <h1 style="margin:0 0 20px;font-size:22px;color:#f8fafc">Réinitialisation de votre mot de passe</h1>
    <p style="margin:0 0 16px;line-height:1.6">Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous pour en choisir un nouveau.</p>
    <p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#38bdf8;color:#0f172a;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px">Choisir un nouveau mot de passe</a></p>
    <p style="margin:0 0 16px;font-size:13px;color:#94a3b8;line-height:1.6">Ce lien est valable <strong>une heure</strong> et ne peut servir qu'une seule fois.</p>
    <p style="margin:0 0 16px;font-size:13px;color:#94a3b8;line-height:1.6">Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail : votre mot de passe actuel reste inchangé.</p>
    <p style="margin:24px 0 0;font-size:12px;color:#64748b;word-break:break-all">Si le bouton ne fonctionne pas, copiez ce lien : ${safeUrl}</p>
  </div>
</body></html>`;

  return { text, html };
}

async function sendPasswordReset(email, resetUrl) {
  if (!config.resendApiKey) {
    /* Mode dégradé assumé : pas de fournisseur configuré. On journalise le
       lien pour le développement local. En production, l'absence de clé doit
       être traitée comme une anomalie de configuration (voir README). */
    logger.warn("[mail] RESEND_API_KEY absent — e-mail non envoyé. Lien de réinitialisation : " + resetUrl);
    return { sent: false, reason: "not_configured" };
  }

  const { text, html } = resetTemplate(resetUrl);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + config.resendApiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: config.mailFrom,
        to: [email],
        subject: "Réinitialisation de votre mot de passe Yuki Trader Pro",
        html,
        text
      })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      /* On ne remonte jamais le détail du fournisseur à l'utilisateur final :
         il peut contenir des informations d'infrastructure. */
      logger.error("[mail] Échec d'envoi Resend (HTTP " + res.status + ") : " + detail.slice(0, 500));
      return { sent: false, reason: "provider_error" };
    }

    return { sent: true };
  } catch (e) {
    logger.error("[mail] Erreur réseau lors de l'envoi : " + (e && e.message));
    return { sent: false, reason: "network_error" };
  }
}

/* BACKEND_17 — envoi générique (même fournisseur, mêmes garde-fous). */
async function sendMail(email, subject, { text, html }) {
  if (!config.resendApiKey) { logger.warn("[mail] RESEND_API_KEY absent — e-mail non envoyé : " + subject + " → " + email); return { sent: false, reason: "not_configured" }; }
  try {
    const res = await fetch(RESEND_ENDPOINT, { method: "POST", headers: { "Authorization": "Bearer " + config.resendApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.mailFrom, to: [email], subject, html, text }) });
    if (!res.ok) { const detail = await res.text().catch(() => ""); logger.error("[mail] Échec d'envoi Resend (HTTP " + res.status + ") : " + detail.slice(0, 500)); return { sent: false, reason: "provider_error" }; }
    return { sent: true };
  } catch (e) { logger.error("[mail] Erreur réseau lors de l'envoi : " + (e && e.message)); return { sent: false, reason: "network_error" }; }
}

/* BACKEND_17 — « Ton essai Yuki » : UN seul courrier, après la fin de l'essai,
   aux comptes qui ne se sont pas abonnés. Un lien vers le questionnaire
   dans l'application, et la promesse écrite qu'il n'y en aura pas d'autre. */
function trialFeedbackTemplate(feedbackUrl) {
  const safeUrl = escapeHtml(feedbackUrl);
  const text = [
    "Ton essai de Yuki Trader Pro est terminé — merci de l'avoir testé.",
    "",
    "Tu n'as pas pris d'abonnement, et c'est très bien : on aimerait juste comprendre pourquoi.",
    "Trente secondes, quelques cases à cocher, et une note si tu veux :",
    "",
    feedbackUrl,
    "",
    "Tes réponses servent à améliorer l'application. Elles ne sont jamais publiées.",
    "Tu ne recevras pas d'autre message de ce type.",
    "",
    "— Simon, Yuki Trader Pro"
  ].join("\n");
  const html = `<!doctype html><html lang="fr"><body style="margin:0;padding:24px;background:#0f172a;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e2e8f0">
  <div style="max-width:520px;margin:0 auto;background:#1e293b;border-radius:12px;padding:32px">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;color:#38bdf8">YUKI TRADER PRO</p>
    <h1 style="margin:0 0 20px;font-size:22px;color:#f8fafc">Ton essai est terminé — merci de l'avoir testé</h1>
    <p style="margin:0 0 16px;line-height:1.6">Tu n'as pas pris d'abonnement, et c'est très bien : on aimerait juste comprendre pourquoi. Trente secondes, quelques cases à cocher, et une note si tu veux.</p>
    <p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;background:#38bdf8;color:#0f172a;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px">Donner mon avis</a></p>
    <p style="margin:0 0 16px;font-size:13px;color:#94a3b8;line-height:1.6">Tes réponses servent à améliorer l'application. Elles ne sont jamais publiées. Tu ne recevras pas d'autre message de ce type.</p>
    <p style="margin:24px 0 0;font-size:12px;color:#64748b;word-break:break-all">Si le bouton ne fonctionne pas, copie ce lien : ${safeUrl}</p>
    <p style="margin:16px 0 0;font-size:12px;color:#64748b">— Simon, Yuki Trader Pro</p>
  </div></body></html>`;
  return { text, html };
}
async function sendTrialFeedback(email, feedbackUrl) { return sendMail(email, "Ton essai Yuki Trader Pro — 30 secondes pour nous aider", trialFeedbackTemplate(feedbackUrl)); }

/* BACKEND_17 — aux ABONNÉS, une seule fois : une note et un commentaire sur Google Play. */
function subscriberReviewTemplate(feedbackUrl, playUrl) {
  const safeUrl = escapeHtml(feedbackUrl), safePlay = escapeHtml(playUrl);
  const text = [
    "Merci d'être abonné à Yuki Trader Pro.",
    "",
    "Si l'application t'est utile, une note et un commentaire sur Google Play nous aident vraiment :",
    playUrl,
    "",
    "Tu peux aussi écrire ton commentaire dans l'application, il sera copié pour Google Play :",
    feedbackUrl,
    "",
    "Une note honnête, bonne ou mauvaise : c'est ce qui compte.",
    "Tu ne recevras pas d'autre message de ce type.",
    "",
    "— Simon, Yuki Trader Pro"
  ].join("\n");
  const html = `<!doctype html><html lang="fr"><body style="margin:0;padding:24px;background:#0f172a;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e2e8f0">
  <div style="max-width:520px;margin:0 auto;background:#1e293b;border-radius:12px;padding:32px">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;color:#38bdf8">YUKI TRADER PRO</p>
    <h1 style="margin:0 0 20px;font-size:22px;color:#f8fafc">Merci d'être abonné</h1>
    <p style="margin:0 0 16px;line-height:1.6">Si l'application t'est utile, une note et un commentaire sur Google Play nous aident vraiment. Une note honnête, bonne ou mauvaise : c'est ce qui compte.</p>
    <p style="margin:24px 0"><a href="${safePlay}" style="display:inline-block;background:#38bdf8;color:#0f172a;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px">Noter sur Google Play</a></p>
    <p style="margin:0 0 16px;font-size:13px;color:#94a3b8;line-height:1.6">Tu peux aussi <a href="${safeUrl}" style="color:#38bdf8">écrire ton commentaire dans l'application</a> : il sera copié pour Google Play. Tu ne recevras pas d'autre message de ce type.</p>
    <p style="margin:16px 0 0;font-size:12px;color:#64748b">— Simon, Yuki Trader Pro</p>
  </div></body></html>`;
  return { text, html };
}
async function sendSubscriberReview(email, feedbackUrl, playUrl) { return sendMail(email, "Merci d'être abonné — une note sur Google Play ?", subscriberReviewTemplate(feedbackUrl, playUrl)); }

module.exports = { sendPasswordReset, sendMail, sendTrialFeedback, trialFeedbackTemplate, sendSubscriberReview, subscriberReviewTemplate };
