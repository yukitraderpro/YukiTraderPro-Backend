#!/usr/bin/env node
/* Exécute tous les fichiers test/*.test.js en sous-processus (isolation des
   variables d'environnement et du cache de modules entre suites), et
   agrège le résultat. Usage : node test/run-all.js  (ou `npm test`). */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith(".test.js"))
  .sort();

let allOk = true;
for (const file of files) {
  console.log(`\n${"=".repeat(70)}\n ${file}\n${"=".repeat(70)}`);
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: "inherit" });
  if (res.status !== 0) allOk = false;
}

console.log(`\n${"=".repeat(70)}`);
console.log(allOk ? "✅ Toutes les suites de tests backend sont passées." : "❌ Au moins une suite de tests backend a échoué.");
process.exit(allOk ? 0 : 1);
