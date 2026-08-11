/* ==========================================================================
   Limitation de débit sur les routes sensibles (V4.11)
   --------------------------------------------------------------------------
   Ces tests existent parce que les routes d'authentification ont été livrées
   sans protection : /login acceptait un nombre illimité d'essais de mot de
   passe, et /forgot-password permettait de déclencher autant d'e-mails que
   voulu vers l'adresse d'un tiers — au passage, de quoi épuiser le quota
   Resend en quelques minutes.
   ========================================================================== */
process.env.NODE_ENV = "test";

const assert = require("node:assert");
const rateLimit = require("../src/middleware/rateLimit");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  \u2713 " + name); }
  catch (e) { failed++; console.log("  \u2717 " + name + "\n    " + (e.stack || e.message)); }
}
function summary() {
  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
  if (failed > 0) process.exit(1);
}

/* Contexte minimal imitant ce que le routeur fournit. */
function ctxFor(ip) {
  return { req: { headers: { "x-forwarded-for": ip }, socket: { remoteAddress: ip } } };
}

/* Appelle le middleware et rapporte s'il a laissé passer. */
async function call(mw, ip) {
  let through = false;
  try {
    await mw(ctxFor(ip), async () => { through = true; });
    return { through, status: null };
  } catch (e) {
    return { through, status: e.status || e.statusCode || null };
  }
}

(async () => {
  console.log("\n== Limitation de débit ==\n");

  await test("les appels sous le seuil passent", async () => {
    const mw = rateLimit("t_basic", 3, 60000);
    for (let i = 0; i < 3; i++) {
      const r = await call(mw, "10.0.0.1");
      assert.strictEqual(r.through, true, `appel ${i + 1} aurait dû passer`);
    }
  });

  await test("le dépassement du seuil renvoie 429", async () => {
    const mw = rateLimit("t_block", 2, 60000);
    await call(mw, "10.0.0.2");
    await call(mw, "10.0.0.2");
    const r = await call(mw, "10.0.0.2");
    assert.strictEqual(r.through, false, "le 3e appel aurait dû être bloqué");
    assert.strictEqual(r.status, 429);
  });

  await test("le blocage est propre à une IP : les autres ne sont pas pénalisées", async () => {
    const mw = rateLimit("t_iso", 1, 60000);
    await call(mw, "10.0.0.3");
    const blocked = await call(mw, "10.0.0.3");
    const other = await call(mw, "10.0.0.4");
    assert.strictEqual(blocked.through, false);
    assert.strictEqual(other.through, true, "une IP tierce ne doit pas hériter du blocage");
  });

  await test("deux limiteurs distincts ont des compteurs indépendants", async () => {
    /* Épuiser /login ne doit pas fermer /forgot-password : ce sont des
       parcours différents pour l'utilisateur. */
    const login = rateLimit("t_login", 1, 60000);
    const forgot = rateLimit("t_forgot", 1, 60000);
    await call(login, "10.0.0.5");
    const loginBlocked = await call(login, "10.0.0.5");
    const forgotOk = await call(forgot, "10.0.0.5");
    assert.strictEqual(loginBlocked.through, false);
    assert.strictEqual(forgotOk.through, true, "les seaux doivent être indépendants");
  });

  await test("la fenêtre glisse : après expiration, les appels repassent", async () => {
    const mw = rateLimit("t_window", 1, 50); // fenêtre très courte pour le test
    await call(mw, "10.0.0.6");
    const blocked = await call(mw, "10.0.0.6");
    assert.strictEqual(blocked.through, false);
    await new Promise(r => setTimeout(r, 70));
    const after = await call(mw, "10.0.0.6");
    assert.strictEqual(after.through, true, "la fenêtre expirée doit libérer l'IP");
  });

  await test("une IP absente des en-têtes ne fait pas planter le middleware", async () => {
    const mw = rateLimit("t_noip", 2, 60000);
    let through = false;
    await mw({ req: { headers: {}, socket: {} } }, async () => { through = true; });
    assert.strictEqual(through, true);
  });

  console.log("\n== Couverture des routes d'authentification ==\n");

  await test("register, login, forgot-password et reset-password sont protégés", () => {
    const src = require("fs").readFileSync(__dirname + "/../src/routes/auth.js", "utf8");
    for (const route of ["/register", "/login", "/forgot-password", "/reset-password"]) {
      const re = new RegExp(`router\\.post\\("${route}",\\s*rateLimit\\(`);
      assert.ok(re.test(src), `${route} doit être protégé par rateLimit`);
    }
  });

  await test("/forgot-password est plus strict que /login (coût d'un e-mail)", () => {
    const src = require("fs").readFileSync(__dirname + "/../src/routes/auth.js", "utf8");
    const forgot = src.match(/rateLimit\("forgotPassword",\s*(\d+)/);
    const login = src.match(/rateLimit\("login",\s*(\d+)/);
    assert.ok(forgot && login, "les deux limiteurs doivent être présents");
    assert.ok(Number(forgot[1]) < Number(login[1]),
      "envoyer un e-mail à un tiers doit être plus contraint qu'un essai de connexion");
  });

  summary();
})();
