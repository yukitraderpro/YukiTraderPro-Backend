/* Petit client HTTP pour les tests d'intégration — évite une dépendance à
   `supertest` (indisponible sans accès npm dans cet environnement).
   Gère un jar de cookies minimal (une seule paire nom=valeur par défaut,
   suffisant ici puisqu'on n'utilise qu'un cookie : le refresh token),
   pour pouvoir tester le nouveau flux d'authentification V4 (refresh
   token en cookie HttpOnly, plus en JSON/localStorage). */
const http = require("http");

function parseSetCookie(headerValues) {
  if (!headerValues) return {};
  const arr = Array.isArray(headerValues) ? headerValues : [headerValues];
  const out = {};
  for (const raw of arr) {
    const first = raw.split(";")[0];
    const idx = first.indexOf("=");
    if (idx === -1) continue;
    out[first.slice(0, idx).trim()] = first.slice(idx + 1).trim();
  }
  return out;
}

function makeClient(baseUrl) {
  const jar = {}; // name -> value

  const call = function call(method, path, body, token) {
    return new Promise((resolve, reject) => {
      const data = (body !== undefined && body !== null) ? JSON.stringify(body) : null;
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      const cookieHeader = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookieHeader) headers.Cookie = cookieHeader;
      const req = http.request(baseUrl + path, { method, headers, agent: false }, res => {
        Object.assign(jar, parseSetCookie(res.headers["set-cookie"]));
        let d = "";
        res.on("data", c => (d += c));
        res.on("end", () => {
          let json = null;
          try { json = d ? JSON.parse(d) : null; } catch {}
          resolve({ status: res.statusCode, json });
        });
      });
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  };
  call.clearCookies = () => { for (const k of Object.keys(jar)) delete jar[k]; };
  call.getCookie = (name) => jar[name];
  call.setCookie = (name, value) => { jar[name] = value; };
  return call;
}

module.exports = { makeClient };
