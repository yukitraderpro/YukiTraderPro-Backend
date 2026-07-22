const { createApp } = require("./http/server");
const authRoutes = require("./routes/auth");
const syncRoutes = require("./routes/sync");
const billingRoutes = require("./routes/billing");
const notificationsRoutes = require("./routes/notifications");
const healthRoutes = require("./routes/health");
const adminRoutes = require("./routes/admin");
const csvImportRoutes = require("./routes/csvImport");

function buildApp() {
  const app = createApp();
  app.use("/api/auth", authRoutes);
  app.use("/api/sync", syncRoutes);
  app.use("/api/billing", billingRoutes);
  app.use("/api/notifications", notificationsRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/csv", csvImportRoutes);
  app.use("/api", healthRoutes);
  return app;
}

module.exports = buildApp;
