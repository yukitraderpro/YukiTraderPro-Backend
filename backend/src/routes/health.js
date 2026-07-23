const Router = require("../http/router");
const { metrics } = require("../http/server");
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

router.get("/metrics", async ctx => {
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
