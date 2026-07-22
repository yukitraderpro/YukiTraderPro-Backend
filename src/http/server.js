/* ==========================================================================
   Serveur HTTP applicatif — construit sur le module natif `http` de Node
   (pas d'Express, faute d'accès npm dans cet environnement — voir
   README_BACKEND.md). Fournit : parsing JSON, CORS, logging structuré des
   requêtes, compteurs pour le monitoring (/api/health, /api/metrics),
   gestion d'erreurs centralisée.
   ========================================================================== */
const http = require("http");
const crypto = require("crypto");
const config = require("../config");
const logger = require("../logger");

const metrics = {
  startedAt: Date.now(),
  requestCount: 0,
  errorCount: 0,
  byRoute: {} // "METHOD path" -> count
};

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    const MAX = 2 * 1024 * 1024; // 2 Mo — suffisant pour un état de synchronisation JSON
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX) { reject(new HttpError(413, "Corps de requête trop volumineux.")); req.destroy(); return; }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try { resolve(JSON.parse(data)); }
      catch { reject(new HttpError(400, "JSON invalide.")); }
    });
    req.on("error", reject);
  });
}

/* ---- Cookies -------------------------------------------------------------
   Implémentation maison (pas de dépendance `cookie`/npm indisponible ici).
   Utilisée exclusivement pour le refresh token (V4 commerciale) : le
   refresh token n'est JAMAIS renvoyé dans le corps JSON ni stocké en
   localStorage côté client — voir routes/auth.js. */
function parseCookies(req) {
  const header = req.headers["cookie"];
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  let str = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAgeSeconds !== undefined) str += `; Max-Age=${Math.floor(opts.maxAgeSeconds)}`;
  str += `; Path=${opts.path || "/"}`;
  if (opts.httpOnly !== false) str += "; HttpOnly";
  str += `; SameSite=${opts.sameSite || "Strict"}`;
  if (opts.secure !== false) str += "; Secure";
  return str;
}

/* CORS + cookies : jamais de wildcard "*" combiné à Allow-Credentials (le
   navigateur le rejette de toute façon, et c'est dangereux en soi). On
   n'autorise que les origines explicitement configurées (CORS_ORIGIN,
   liste séparée par des virgules) ; à défaut de correspondance, aucune
   origine n'est autorisée (pas de repli permissif). */
function resolveAllowedOrigin(requestOrigin) {
  if (config.corsOrigin === "*") return requestOrigin || null; // dev only, voir avertissement au démarrage
  const allowed = config.corsOrigin.split(",").map(s => s.trim()).filter(Boolean);
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return null;
}

function createApp() {
  const mounts = []; // { prefix, router }
  const app = {};

  app.use = (prefix, router) => { mounts.push({ prefix, router }); };
  app.metrics = metrics;

  app.requestListener = async (req, res) => {
    const requestId = crypto.randomBytes(8).toString("hex");
    const startedAt = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    const allowedOrigin = resolveAllowedOrigin(req.headers.origin);
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const cookies = parseCookies(req);
    const pendingCookies = [];

    const respondJson = (status, payload) => {
      const body = JSON.stringify(payload);
      if (pendingCookies.length) res.setHeader("Set-Cookie", pendingCookies);
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Connection": "close"
      });
      res.end(body);
    };
    res.json = respondJson;
    res.setCookie = (name, value, opts) => { pendingCookies.push(serializeCookie(name, value, opts)); };
    res.clearCookie = (name, opts = {}) => { pendingCookies.push(serializeCookie(name, "", { ...opts, maxAgeSeconds: 0 })); };

    let matched = null, params = {};
    for (const { prefix, router } of mounts) {
      if (!url.pathname.startsWith(prefix)) continue;
      const sub = url.pathname.slice(prefix.length) || "/";
      const m = router.match(req.method, sub);
      if (m) { matched = m; params = m.params; break; }
    }

    metrics.requestCount++;
    const routeKey = `${req.method} ${url.pathname}`;
    metrics.byRoute[routeKey] = (metrics.byRoute[routeKey] || 0) + 1;

    try {
      if (!matched) { respondJson(404, { error: "Route introuvable." }); return; }

      let body;
      if (req.method === "POST" || req.method === "PUT") body = await readBody(req);

      const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body, cookies, requestId };
      let idx = 0;
      const next = async () => {
        const handler = matched.handlers[idx++];
        if (!handler) return;
        await handler(ctx, next);
      };
      await next();
    } catch (err) {
      metrics.errorCount++;
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) logger.error("Erreur non gérée", { requestId, route: routeKey, error: err.message, stack: err.stack });
      respondJson(status, { error: err.message || "Erreur interne.", details: err.details });
    } finally {
      logger.info("requête", { requestId, method: req.method, path: url.pathname, status: res.statusCode, durationMs: Date.now() - startedAt });
    }
  };

  app.listen = (port, host, cb) => {
    if (config.corsOrigin === "*" && config.nodeEnv === "production") {
      logger.error("CORS_ORIGIN=\"*\" en production : les cookies d'authentification (refresh token) ne fonctionneront pour AUCUNE origine tant qu'un domaine explicite n'est pas configuré (voir .env.example).");
    }
    const server = http.createServer(app.requestListener);
    server.listen(port, host, cb);
    return server;
  };

  return app;
}

module.exports = { createApp, HttpError, metrics };
