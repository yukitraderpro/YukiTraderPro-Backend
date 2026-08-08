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

module.exports = { sendPasswordReset };
