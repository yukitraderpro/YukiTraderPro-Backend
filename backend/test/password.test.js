const assert = require("assert");
const { hashPassword, verifyPassword } = require("../src/crypto/password");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + e.message); }
}

console.log("\n== password.js (scrypt) ==\n");

test("hashPassword produit un format scrypt$N$r$p$sel$hash", () => {
  const h = hashPassword("motdepasse123");
  const parts = h.split("$");
  assert.strictEqual(parts[0], "scrypt");
  assert.strictEqual(parts.length, 6);
});
test("verifyPassword accepte le bon mot de passe", () => {
  const h = hashPassword("motdepasse123");
  assert.strictEqual(verifyPassword("motdepasse123", h), true);
});
test("verifyPassword rejette un mauvais mot de passe", () => {
  const h = hashPassword("motdepasse123");
  assert.strictEqual(verifyPassword("autrechose", h), false);
});
test("deux hachages du même mot de passe sont différents (sel aléatoire)", () => {
  assert.notStrictEqual(hashPassword("abc"), hashPassword("abc"));
});
test("verifyPassword ne plante pas sur une entrée corrompue", () => {
  assert.strictEqual(verifyPassword("abc", "n'importe quoi"), false);
});

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
process.exit(failed ? 1 : 0);
