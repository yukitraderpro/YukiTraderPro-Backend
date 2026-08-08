/* ==========================================================================
   Configuration — lue depuis les variables d'environnement.
   --------------------------------------------------------------------------
   Aucune dépendance externe (pas de `dotenv`) : au démarrage, `server.js`
   charge lui-même un fichier `.env` s'il existe (voir src/loadEnv.js), pour
   rester utilisable même dans un environnement sans accès npm. En
   production, ces valeurs doivent être injectées par la plateforme
   d'hébergement (variables d'environnement natives), pas par un fichier
   `.env` committé.
   ========================================================================== */
function required(name, fallback) {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  return fallback;
}

const config = {
  port: parseInt(required("PORT", "4000"), 10),
  host: required("HOST", "0.0.0.0"),
  nodeEnv: required("NODE_ENV", "development"),

  // Secrets JWT — DOIVENT être remplacés en production (voir .env.example).
  jwtAccessSecret: required("JWT_ACCESS_SECRET", "dev-insecure-access-secret-change-me"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET", "dev-insecure-refresh-secret-change-me"),
  jwtAccessTtlSeconds: parseInt(required("JWT_ACCESS_TTL_SECONDS", "900"), 10), // 15 min
  jwtRefreshTtlSeconds: parseInt(required("JWT_REFRESH_TTL_SECONDS", String(60 * 60 * 24 * 30)), 10), // 30 j

  dbPath: required("DB_PATH", "./data/yuki.sqlite"),
  backupDir: required("BACKUP_DIR", "./data/backups"),
  backupIntervalHours: parseInt(required("BACKUP_INTERVAL_HOURS", "24"), 10),
  backupRetentionCount: parseInt(required("BACKUP_RETENTION_COUNT", "14"), 10),

  logDir: required("LOG_DIR", "./data/logs"),
  logLevel: required("LOG_LEVEL", "info"),

  corsOrigin: required("CORS_ORIGIN", "*"),

  /* Envoi d'e-mails transactionnels (réinitialisation de mot de passe).
     RESEND_API_KEY vide = envoi désactivé, le lien est alors seulement
     journalisé (utile en développement, anomalie en production).
     APP_PUBLIC_URL sert à construire le lien de réinitialisation : il doit
     pointer vers le frontend, pas vers l'API. */
  resendApiKey: required("RESEND_API_KEY", ""),
  mailFrom: required("MAIL_FROM", "Yuki Trader Pro <noreply@yukitraderpro.com>"),
  appPublicUrl: required("APP_PUBLIC_URL", "https://www.yukitraderpro.com").replace(/\/+$/, ""),
  passwordResetTtlSeconds: parseInt(required("PASSWORD_RESET_TTL_SECONDS", "3600"), 10),

  // Cookie httpOnly du refresh token (V4 commerciale — jamais de refresh
  // token en localStorage). `Secure` est désactivé automatiquement hors
  // production pour permettre les tests locaux en http://localhost.
  refreshCookieName: required("REFRESH_COOKIE_NAME", "yuki_refresh"),
  cookieSecure: required("COOKIE_SECURE", required("NODE_ENV", "development") === "production" ? "true" : "false") === "true",
  // "Strict"/"Lax" seulement valable en same-origin (ex. proxy Netlify /api).
  // En déploiement cross-origin (ex. Render : frontend et backend sur deux
  // sous-domaines .onrender.com distincts), le cookie de refresh ne sera
  // JAMAIS renvoyé par le navigateur si SameSite=Strict — mettre
  // COOKIE_SAMESITE=None (nécessite cookieSecure=true, déjà le cas en prod).
  cookieSameSite: required("COOKIE_SAMESITE", "Strict"),

  // Google Play Billing (Play Developer API — androidpublisher).
  // Nécessite un compte de service Google Cloud avec accès Play Console.
  googlePlay: {
    packageName: required("GOOGLE_PLAY_PACKAGE_NAME", ""),
    serviceAccountEmail: required("GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL", ""),
    serviceAccountPrivateKey: required("GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY", "").replace(/\\n/g, "\n")
  },

  // Firebase Cloud Messaging (HTTP v1 API).
  firebase: {
    projectId: required("FIREBASE_PROJECT_ID", ""),
    serviceAccountEmail: required("FIREBASE_SERVICE_ACCOUNT_EMAIL", ""),
    serviceAccountPrivateKey: required("FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY", "").replace(/\\n/g, "\n")
  },

  // Clé Twelve Data utilisée UNIQUEMENT par le job planifié optionnel
  // (scan côté serveur pour notifications app fermée). Voir jobs/scheduledScan.js.
  scheduledScan: {
    enabled: required("SCHEDULED_SCAN_ENABLED", "false") === "true",
    intervalMinutes: parseInt(required("SCHEDULED_SCAN_INTERVAL_MINUTES", "15"), 10)
  }
};

module.exports = config;
