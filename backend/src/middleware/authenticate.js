const { verify, JwtError } = require("../crypto/jwt");
const config = require("../config");
const { HttpError } = require("../http/server");

/* Middleware : exige un access token JWT valide dans `Authorization: Bearer <token>`.
   Pose `ctx.userId` et `ctx.tokenPayload` pour les handlers suivants. */
async function authenticate(ctx, next) {
  const header = ctx.req.headers["authorization"] || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) throw new HttpError(401, "Authentification requise.");
  try {
    const payload = verify(token, config.jwtAccessSecret);
    if (payload.type !== "access") throw new Error("type de token incorrect");
    ctx.userId = payload.sub;
    ctx.tokenPayload = payload;
  } catch (e) {
    throw new HttpError(401, e instanceof JwtError ? "Token invalide ou expiré." : "Authentification invalide.");
  }
  await next();
}

module.exports = authenticate;
