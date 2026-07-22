const assert = require("assert");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + (e.stack || e.message)); }
}

// On charge le module server.js mais ses fonctions internes (parseCookies,
// serializeCookie, resolveAllowedOrigin) ne sont pas exportées (elles n'ont
// pas besoin de l'être en dehors des tests) : on les revalide donc via des
// requêtes HTTP réelles bout-en-bout dans cette suite, en instanciant un
// serveur minimal qui expose une route de test.
process.env.DB_PATH = "/tmp/yuki_test_cookies_" + Date.now() + ".sqlite";
process.env.LOG_DIR = "/tmp/yuki_test_logs";
process.env.BACKUP_DIR = "/tmp/yuki_test_backups";
process.env.CORS_ORIGIN = "https://app.yukitrader.example,https://admin.yukitrader.example";

const http = require("http");
const { createApp } = require("../src/http/server");
const Router = require("../src/http/router");

async function main() {
  console.log("\n== Unitaire : cookies HttpOnly (refresh token) + CORS credentials ==\n");

  const router = new Router();
  router.post("/set", async ctx => {
    ctx.res.setCookie("test_cookie", "valeur-avec-espace & signe", { httpOnly: true, secure: false, sameSite: "Strict", path: "/", maxAgeSeconds: 3600 });
    ctx.res.json(200, { ok: true });
  });
  router.get("/echo-cookie", async ctx => {
    ctx.res.json(200, { received: ctx.cookies.test_cookie || null });
  });
  router.post("/clear", async ctx => {
    ctx.res.clearCookie("test_cookie", { path: "/" });
    ctx.res.json(200, { ok: true });
  });

  const app = createApp();
  app.use("/api/test", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const port = server.address().port;

  function call(method, path, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? JSON.stringify(body) : null;
      const req = http.request(`http://127.0.0.1:${port}${path}`, { method, headers: { "Content-Type": "application/json", ...headers } }, res => {
        let d = "";
        res.on("data", c => (d += c));
        res.on("end", () => {
          let json = null; try { json = d ? JSON.parse(d) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      });
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  let setCookieHeader;
  await (async () => {
    const r = await call("POST", "/api/test/set", { body: {} });
    test("le serveur pose bien un Set-Cookie HttpOnly; SameSite=Strict", () => {
      assert.ok(r.headers["set-cookie"] && r.headers["set-cookie"].length);
      setCookieHeader = r.headers["set-cookie"][0];
      assert.ok(/HttpOnly/.test(setCookieHeader));
      assert.ok(/SameSite=Strict/.test(setCookieHeader));
      assert.ok(/Max-Age=3600/.test(setCookieHeader));
    });
  })();

  await (async () => {
    const cookiePair = setCookieHeader.split(";")[0];
    const r = await call("GET", "/api/test/echo-cookie", { headers: { Cookie: cookiePair } });
    test("le serveur relit correctement un cookie envoyé par le client (valeurs spéciales décodées)", () => {
      assert.strictEqual(r.json.received, "valeur-avec-espace & signe");
    });
  })();

  await (async () => {
    const r = await call("GET", "/api/test/echo-cookie");
    test("l'absence de cookie ne fait pas planter le parsing (objet vide)", () => {
      assert.strictEqual(r.json.received, null);
    });
  })();

  await (async () => {
    const r = await call("POST", "/api/test/clear", { body: {} });
    test("clearCookie renvoie un Set-Cookie avec Max-Age=0 (suppression)", () => {
      const header = r.headers["set-cookie"][0];
      assert.ok(/Max-Age=0/.test(header));
    });
  })();

  await (async () => {
    const r = await call("GET", "/api/test/echo-cookie", { headers: { Origin: "https://app.yukitrader.example" } });
    test("une origine explicitement autorisée reçoit Access-Control-Allow-Credentials + son origine exacte (jamais *)", () => {
      assert.strictEqual(r.headers["access-control-allow-origin"], "https://app.yukitrader.example");
      assert.strictEqual(r.headers["access-control-allow-credentials"], "true");
    });
  })();

  await (async () => {
    const r = await call("GET", "/api/test/echo-cookie", { headers: { Origin: "https://evil.example" } });
    test("une origine NON autorisée ne reçoit aucun header CORS permissif (pas de repli sur *)", () => {
      assert.strictEqual(r.headers["access-control-allow-origin"], undefined);
      assert.strictEqual(r.headers["access-control-allow-credentials"], undefined);
    });
  })();

  server.close();
  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
  process.exit(failed ? 1 : 0);
}
main();
