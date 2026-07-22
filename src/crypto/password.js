/* ==========================================================================
   Hachage de mot de passe — scrypt (module natif `crypto` de Node).
   --------------------------------------------------------------------------
   Choix : bcrypt est la référence habituelle mais nécessite une dépendance
   npm (`bcryptjs`/`bcrypt`), indisponible dans cet environnement de
   développement hors-ligne. `scrypt` est intégré à Node, reconnu comme
   fonction de dérivation de clé résistante au brute-force matériel
   (recommandé par l'OWASP au même titre qu'Argon2/bcrypt), et suffisant
   pour cet usage. Le format de sortie inclut le sel et les paramètres pour
   permettre une migration future sans invalider les mots de passe existants.
   ========================================================================== */
const crypto = require("crypto");

const KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }; // paramètres recommandés OWASP pour scrypt

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plain, salt, KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function verifyPassword(plain, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = crypto.scryptSync(plain, salt, expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
