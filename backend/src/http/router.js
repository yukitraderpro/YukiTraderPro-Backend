/* ==========================================================================
   Routeur HTTP minimal (équivalent maison à express.Router), sans
   dépendance externe. Supporte les paramètres de chemin (`/users/:id`) et
   les chaînes de middlewares par route.
   ========================================================================== */
class Router {
  constructor() {
    this.routes = []; // { method, pattern: RegExp, paramNames, handlers: [] }
  }

  _register(method, path, handlers) {
    const paramNames = [];
    const regexPath = path
      .split("/")
      .map(seg => {
        if (seg.startsWith(":")) { paramNames.push(seg.slice(1)); return "([^/]+)"; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    const pattern = new RegExp(`^${regexPath}/?$`);
    this.routes.push({ method: method.toUpperCase(), pattern, paramNames, handlers });
  }

  get(path, ...handlers) { this._register("GET", path, handlers); }
  post(path, ...handlers) { this._register("POST", path, handlers); }
  put(path, ...handlers) { this._register("PUT", path, handlers); }
  delete(path, ...handlers) { this._register("DELETE", path, handlers); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      return { handlers: route.handlers, params };
    }
    return null;
  }
}

module.exports = Router;
