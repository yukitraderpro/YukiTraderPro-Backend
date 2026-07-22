/* ==========================================================================
   Logger structuré (JSON), sans dépendance externe (équivalent maison à
   pino/winston). Écrit sur stdout ET dans un fichier journalier tournant
   dans `config.logDir`, pour répondre à l'exigence « Journalisation et
   monitoring » du cahier des charges V3.
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const config = require("./config");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[config.logLevel] || LEVELS.info;

function ensureLogDir() {
  try { fs.mkdirSync(config.logDir, { recursive: true }); } catch {}
}
ensureLogDir();

function currentLogFile() {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(config.logDir, `yuki-backend-${stamp}.log`);
}

function write(level, message, meta) {
  if (LEVELS[level] < minLevel) return;
  const entry = { time: new Date().toISOString(), level, message, ...meta };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line); else console.log(line);
  try { fs.appendFileSync(currentLogFile(), line + "\n"); } catch {}
}

const logger = {
  debug: (message, meta) => write("debug", message, meta),
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta)
};

module.exports = logger;
