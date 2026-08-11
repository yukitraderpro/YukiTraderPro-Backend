const Router = require("../http/router");
const authenticate = require("../middleware/authenticate");
const { metrics, HttpError } = require("../http/server");
const db = require("../db");

const router = new Router();

router.get("/health", async ctx => {
  let dbOk = true;
  try { db.get().prepare("SELECT 1").get(); } catch { dbOk = false; }
  ctx.res.json(dbOk ? 200 : 503, {
    status: dbOk ? "ok" : "degraded",
    uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1000),
    db: dbOk ? "ok" : "unreachable"
  });
});

/* /metrics expose la version de Node, l'usage mémoire et le détail des appels
   par route. C'est utile en exploitation, mais donné publiquement cela aide un
   attaquant à cibler des failles connues de la version en place et à observer
   l'activité du service. On le réserve donc aux administrateurs. */
router.get("/metrics", authenticate, async ctx => {
  const user = db.get().prepare("SELECT role FROM users WHERE id = ?").get(ctx.userId);
  if (!user || user.role !== "admin") throw new HttpError(403, "Accès réservé aux administrateurs.");

  const mem = process.memoryUsage();
  ctx.res.json(200, {
    uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1000),
    requestCount: metrics.requestCount,
    errorCount: metrics.errorCount,
    byRoute: metrics.byRoute,
    memory: { rssMb: +(mem.rss / 1048576).toFixed(1), heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1) },
    nodeVersion: process.version
  });
});

module.exports = router;
