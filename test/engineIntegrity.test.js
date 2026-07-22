/* ==========================================================================
   Test d'intégrité du moteur d'analyse — traduit mécaniquement la
   contrainte du cahier des charges V3 : « Le moteur d'analyse V2 reste
   inchangé. [...] Aucune modification des pondérations ou des règles
   métier sans validation. »
   --------------------------------------------------------------------------
   Ce test compare, octet par octet (empreinte SHA-256), la copie du moteur
   utilisée par le backend (`backend/src/analysisEngine/analysis.js`) avec
   le fichier livré au client (`../../analysis.js`, à la racine du projet).
   S'il échoue, c'est le signal qu'une modification du moteur a été
   introduite quelque part — volontairement ou par erreur — et qu'elle doit
   être validée explicitement avant d'être conservée.
   ========================================================================== */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n    " + e.message); }
}

console.log("\n== Intégrité du moteur d'analyse (contrainte V3) ==\n");

const clientEnginePath = path.join(__dirname, "..", "..", "analysis.js");
const backendEnginePath = path.join(__dirname, "..", "src", "analysisEngine", "analysis.js");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("le fichier moteur du client existe", () => {
  assert.ok(fs.existsSync(clientEnginePath), `attendu à ${clientEnginePath}`);
});
test("la copie serveur du moteur existe", () => {
  assert.ok(fs.existsSync(backendEnginePath), `attendu à ${backendEnginePath}`);
});
test("la copie serveur est strictement identique (octet par octet) au moteur client", () => {
  const clientHash = sha256(clientEnginePath);
  const backendHash = sha256(backendEnginePath);
  assert.strictEqual(backendHash, clientHash,
    "Le moteur d'analyse serveur a divergé du moteur client — toute divergence doit être validée explicitement avant d'être committée (cahier des charges V3, principe fondamental).");
});
test("le moteur exporte toujours les fonctions attendues (aucune régression d'API)", () => {
  const engine = require(backendEnginePath);
  ["buildConfluence", "computeScenarios", "evaluateSignal", "updateIndicatorWeights",
   "defaultIndicatorWeights", "isDataInsufficient", "gradeQuality", "riskLevel"]
    .forEach(fnName => assert.strictEqual(typeof engine[fnName], "function", `${fnName} doit être exporté`));
});

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
process.exit(failed ? 1 : 0);
