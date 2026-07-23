/* ==========================================================================
   Service d'authentification — inscription, connexion, émission et
   rotation des tokens JWT (access court + refresh long, révocable),
   conforme au principe « Authentification JWT » du cahier des charges V3.
   --------------------------------------------------------------------------
   Stratégie de rotation des refresh tokens : chaque refresh consomme le
   token présenté (marqué révoqué) et en émet un nouveau. Cela permet de
   détecter un refresh token volé/rejoué : s'il est présenté une seconde
   fois après rotation, il est refusé (déjà révoqué en base).
   ========================================================================== */
const crypto = require("crypto");
const db = require("../db");
const config = require("../config");
const { hashPassword, verifyPassword } = require("../crypto/password");
const jwt = require("../crypto/jwt");
const { HttpError } = require("../http/server");

function newId() { return crypto.randomUUID(); }
function normEmail(email) { return String(email || "").trim().toLowerCase(); }
function sha256(str) { return crypto.createHash("sha256").update(str).digest("hex"); }

const TRIAL_DAYS = 7;

function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    trialUntil: row.trial_until,
    subscribed: !!row.subscribed
  };
}

function register(email, password) {
  email = normEmail(email);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "Adresse e-mail invalide.");
  if (!password || password.length < 8) throw new HttpError(400, "Le mot de passe doit contenir au moins 8 caractères.");
  const conn = db.get();
  const existing = conn.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) throw new HttpError(409, "Un compte existe déjà avec cet e-mail.");
  const now = Date.now();
  const id = newId();
  conn.prepare(`
    INSERT INTO users (id, email, password_hash, role, created_at, trial_until, subscribed)
    VALUES (?, ?, ?, 'free', ?, ?, 0)
  `).run(id, email, hashPassword(password), now, now + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  return toPublicUser(conn.prepare("SELECT * FROM users WHERE id = ?").get(id));
}

function verifyCredentials(email, password) {
  email = normEmail(email);
  const conn = db.get();
  const row = conn.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!row || !verifyPassword(password, row.password_hash)) throw new HttpError(401, "E-mail ou mot de passe incorrect.");
  return row;
}

function issueTokenPair(userRow, deviceId) {
  const accessToken = jwt.sign(
    { sub: userRow.id, email: userRow.email, role: userRow.role, type: "access" },
    config.jwtAccessSecret,
    { expiresInSeconds: config.jwtAccessTtlSeconds }
  );
  const jti = newId();
  const refreshToken = jwt.sign(
    { sub: userRow.id, type: "refresh", jti },
    config.jwtRefreshSecret,
    { expiresInSeconds: config.jwtRefreshTtlSeconds }
  );
  const now = Date.now();
  db.get().prepare(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, device_id, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(jti, userRow.id, sha256(refreshToken), deviceId || null, now, now + config.jwtRefreshTtlSeconds * 1000);
  return { accessToken, refreshToken, expiresIn: config.jwtAccessTtlSeconds };
}

function login(email, password, deviceId) {
  const row = verifyCredentials(email, password);
  return { user: toPublicUser(row), ...issueTokenPair(row, deviceId) };
}

function refresh(refreshToken, deviceId) {
  let payload;
  try { payload = jwt.verify(refreshToken, config.jwtRefreshSecret); }
  catch { throw new HttpError(401, "Refresh token invalide ou expiré."); }
  if (payload.type !== "refresh") throw new HttpError(401, "Type de token incorrect.");
  const conn = db.get();
  const record = conn.prepare("SELECT * FROM refresh_tokens WHERE id = ?").get(payload.jti);
  if (!record || record.revoked_at || record.token_hash !== sha256(refreshToken)) {
    throw new HttpError(401, "Refresh token révoqué ou inconnu — reconnexion requise.");
  }
  // Rotation : on révoque le token consommé puis on en émet un nouveau.
  conn.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?").run(Date.now(), record.id);
  const userRow = conn.prepare("SELECT * FROM users WHERE id = ?").get(record.user_id);
  if (!userRow) throw new HttpError(401, "Utilisateur introuvable.");
  return { user: toPublicUser(userRow), ...issueTokenPair(userRow, deviceId) };
}

function logout(refreshToken) {
  let payload;
  try { payload = jwt.verify(refreshToken, config.jwtRefreshSecret); } catch { return; }
  db.get().prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(Date.now(), payload.jti);
}

function getUserById(id) {
  const row = db.get().prepare("SELECT * FROM users WHERE id = ?").get(id);
  return row ? toPublicUser(row) : null;
}

function isTrialActive(user) { return Date.now() < user.trialUntil; }
function isPro(user) { return user.role === "admin" || user.role === "pro" || isTrialActive(user); }

module.exports = { register, login, refresh, logout, getUserById, toPublicUser, isTrialActive, isPro, normEmail };
