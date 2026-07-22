/* ==========================================================================
   Couche base de données — SQLite via le module natif `node:sqlite`
   (Node ≥ 22, encore expérimental). Choix documenté dans README_BACKEND.md
   §"Choix techniques" : aucune dépendance npm n'a pu être installée dans
   l'environnement de développement (accès réseau bloqué), donc le module
   natif de Node a été utilisé plutôt que `better-sqlite3`/`pg`. Le schéma
   ci-dessous est volontairement écrit en SQL standard (types simples,
   pas de fonctionnalités propriétaires SQLite exotiques) pour qu'une
   migration vers PostgreSQL en production soit directe — recommandée dans
   le README pour un vrai déploiement multi-instance.
   ========================================================================== */
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");
const logger = require("./logger");

let db = null;

function open(dbPath = config.dbPath) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate();
  logger.info("Base de données ouverte", { dbPath });
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'free',
      created_at INTEGER NOT NULL,
      trial_until INTEGER NOT NULL,
      subscribed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      device_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT,
      platform TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS notification_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id TEXT,
      fcm_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, fcm_token)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      purchase_token TEXT NOT NULL,
      status TEXT NOT NULL,
      verified_at INTEGER NOT NULL,
      expiry_at INTEGER,
      raw_response TEXT
    );

    CREATE TABLE IF NOT EXISTS subscription_offers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      seat_limit INTEGER,
      seats_used INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_offer_assignments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      offer_id TEXT NOT NULL REFERENCES subscription_offers(id),
      locked_price_cents INTEGER NOT NULL,
      assigned_at INTEGER NOT NULL,
      released_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      ip TEXT,
      meta TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS csv_imports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      source TEXT NOT NULL,
      destination TEXT NOT NULL,
      status TEXT NOT NULL,
      delimiter TEXT,
      headers_json TEXT,
      raw_rows_json TEXT,
      mapping_json TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      imported_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      report_json TEXT,
      created_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      deleted_at INTEGER,
      restore_deadline INTEGER
    );

    CREATE TABLE IF NOT EXISTS csv_import_rows (
      id TEXT PRIMARY KEY,
      import_id TEXT NOT NULL REFERENCES csv_imports(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      destination TEXT NOT NULL,
      symbol TEXT, name TEXT, market TEXT, asset_type TEXT, isin TEXT,
      quantity REAL, entry_price REAL, entry_at TEXT, currency TEXT,
      stop_loss REAL, target REAL, timeframe TEXT, strategy TEXT,
      status_field TEXT, notes TEXT, tags TEXT,
      dedup_hash TEXT NOT NULL,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS csv_source_mappings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      mapping_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, source)
    );

    CREATE TABLE IF NOT EXISTS csv_audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      import_id TEXT,
      action TEXT NOT NULL,
      meta TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_csv_imports_user ON csv_imports(user_id);
    CREATE INDEX IF NOT EXISTS idx_csv_rows_import ON csv_import_rows(import_id);
    CREATE INDEX IF NOT EXISTS idx_csv_rows_user ON csv_import_rows(user_id);
    CREATE INDEX IF NOT EXISTS idx_csv_rows_dedup ON csv_import_rows(user_id, dedup_hash);
    CREATE INDEX IF NOT EXISTS idx_csv_audit_user ON csv_audit_log(user_id);

    CREATE TABLE IF NOT EXISTS offer_price_history (
      id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL REFERENCES subscription_offers(id) ON DELETE CASCADE,
      offer_name TEXT NOT NULL,
      old_price_cents INTEGER,
      new_price_cents INTEGER NOT NULL,
      changed_by TEXT,
      changed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_offer_price_history_offer ON offer_price_history(offer_id);

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_notification_tokens_user ON notification_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_offer_assignments_user ON user_offer_assignments(user_id);
  `);
  seedDefaultOffers();
}

/* ==========================================================================
   Offres d'abonnement par défaut — addendum V3.1 « Abonnements ».
   --------------------------------------------------------------------------
   Insérées une seule fois (si la table est vide) : ensuite, tout se pilote
   depuis l'écran d'administration (prix, activation, nouvelles offres) sans
   jamais republier l'application, conformément à l'exigence explicite de
   l'addendum. Les valeurs ci-dessous ne sont qu'un point de départ.
   ========================================================================== */
function seedDefaultOffers() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM subscription_offers").get();
  if (existing.n > 0) return;
  const now = Date.now();
  const crypto = require("crypto");
  const founderId = crypto.randomUUID();
  const standardId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO subscription_offers (id, name, description, price_cents, currency, seat_limit, seats_used, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'EUR', ?, 0, 1, ?, ?, ?)
  `).run(founderId, "Fondateur", "Tarif à vie réservé aux 1000 premiers abonnés, tant que l'abonnement reste actif.", 990, 1000, 0, now, now);
  db.prepare(`
    INSERT INTO subscription_offers (id, name, description, price_cents, currency, seat_limit, seats_used, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'EUR', NULL, 0, 1, ?, ?, ?)
  `).run(standardId, "Standard", "Offre standard, activée automatiquement une fois les 1000 places Fondateur épuisées.", 1990, 1, now, now);
  db.prepare(`
    INSERT INTO offer_price_history (id, offer_id, offer_name, old_price_cents, new_price_cents, changed_by, changed_at)
    VALUES (?, ?, ?, NULL, ?, 'system:seed', ?)
  `).run(crypto.randomUUID(), founderId, "Fondateur", 990, now);
  db.prepare(`
    INSERT INTO offer_price_history (id, offer_id, offer_name, old_price_cents, new_price_cents, changed_by, changed_at)
    VALUES (?, ?, ?, NULL, ?, 'system:seed', ?)
  `).run(crypto.randomUUID(), standardId, "Standard", 1990, now);
}

function get() {
  if (!db) throw new Error("Base de données non initialisée — appeler open() au démarrage.");
  return db;
}

function close() {
  if (db) { db.close(); db = null; }
}

module.exports = { open, get, close };
