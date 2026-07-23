const assert = require("assert");
const jwt = require("../src/crypto/jwt");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + e.message); }
}

console.log("\n== jwt.js (HS256 maison) ==\n");

test("sign puis verify renvoie le payload d'origine", () => {
  const token = jwt.sign({ sub: "user1", role: "free" }, "secret1");
  const payload = jwt.verify(token, "secret1");
  assert.strictEqual(payload.sub, "user1");
  assert.strictEqual(payload.role, "free");
});
test("le token a bien 3 segments séparés par des points", () => {
  const token = jwt.sign({ sub: "x" }, "secret");
  assert.strictEqual(token.split(".").length, 3);
});
test("verify rejette une signature falsifiée", () => {
  const token = jwt.sign({ sub: "user1" }, "secret1");
  const tampered = token.slice(0, -3) + "xyz";
  assert.throws(() => jwt.verify(tampered, "secret1"));
});
test("verify rejette un mauvais secret", () => {
  const token = jwt.sign({ sub: "user1" }, "secret1");
  assert.throws(() => jwt.verify(token, "mauvais-secret"));
});
test("verify rejette un token expiré", () => {
  const token = jwt.sign({ sub: "user1" }, "secret1", { expiresInSeconds: -10 });
  assert.throws(() => jwt.verify(token, "secret1"), /expiré/);
});
test("verify rejette un format de token invalide", () => {
  assert.throws(() => jwt.verify("pas.un.jwt.valide.du.tout", "secret1"));
  assert.throws(() => jwt.verify("juste-une-chaine", "secret1"));
});
test("le payload contient bien iat et exp quand demandé", () => {
  const token = jwt.sign({ sub: "user1" }, "secret1", { expiresInSeconds: 60 });
  const payload = jwt.verify(token, "secret1");
  assert.ok(typeof payload.iat === "number");
  assert.ok(typeof payload.exp === "number");
  assert.strictEqual(payload.exp - payload.iat, 60);
});

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
process.exit(failed ? 1 : 0);
