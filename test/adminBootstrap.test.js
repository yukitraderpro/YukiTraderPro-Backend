/* ==========================================================================
   Tests — amorçage des comptes administrateurs
   --------------------------------------------------------------------------
   Défaut trouvé le 25/08 : le rôle « admin » ne pouvait s'obtenir que par
   PUT /api/admin/users/:id/role, laquelle exige d'être DÉJÀ administrateur.
   Système circulaire : aucun moyen de créer le premier administrateur, ni de
   retrouver l'accès après une restauration de sauvegarde. Le propriétaire ne
   savait d'ailleurs plus quel compte était promu.
   Ces tests exécutent réellement le service sur une base temporaire.
   ========================================================================== */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "yuki-admin-"));
process.env.DB_PATH = path.join(dossier, "test.sqlite");
process.env.JWT_SECRET = "secret-de-test-suffisamment-long-pour-passer";
process.env.ADMIN_EMAIL = "Chef@Exemple.FR, absent@exemple.fr";

let passed = 0, failed = 0;
function test(name, fn){ try{fn();passed++;console.log("  ✓ "+name)}catch(e){failed++;console.log("  ✗ "+name+"\n    "+e.message)} }

console.log("\n== Amorçage des administrateurs ==\n");

const db = require("../src/db");
db.open();
const conn = db.get();
const maintenant = Date.now();
function creer(email, role) {
  /* id et trial_until sont obligatoires en base : on les fournit. */
  conn.prepare("INSERT INTO users (id, email, password_hash, role, created_at, trial_until) VALUES (?,?,?,?,?,?)")
      .run("u-" + email, email, "x", role, maintenant, maintenant + 7 * 86400000);
}
creer("chef@exemple.fr", "free");
creer("autre@exemple.fr", "free");
creer("deja@exemple.fr", "admin");

const { bootstrapAdmins } = require("../src/services/adminBootstrap");
const bilan = bootstrapAdmins();

test("le compte désigné est promu administrateur", () => {
  const u = conn.prepare("SELECT role FROM users WHERE email = ?").get("chef@exemple.fr");
  assert.strictEqual(u.role, "admin", "le compte n'a pas été promu");
  assert.strictEqual(bilan.promus, 1);
});

test("la casse de l'adresse n'a pas d'importance", () => {
  /* La variable contenait « Chef@Exemple.FR », la base « chef@exemple.fr ». */
  assert.strictEqual(conn.prepare("SELECT role FROM users WHERE email = ?").get("chef@exemple.fr").role, "admin");
});

test("les autres comptes ne sont PAS touchés", () => {
  assert.strictEqual(conn.prepare("SELECT role FROM users WHERE email = ?").get("autre@exemple.fr").role, "free");
});

test("une adresse inexistante est signalée, pas créée", () => {
  /* Créer un compte depuis une variable d'environnement fabriquerait un
     accès sans mot de passe choisi par son propriétaire. */
  assert.deepStrictEqual(bilan.introuvables, ["absent@exemple.fr"]);
  assert.strictEqual(conn.prepare("SELECT COUNT(*) n FROM users WHERE email = ?").get("absent@exemple.fr").n, 0,
    "un compte a été créé alors qu'il ne devait pas l'être");
});

test("un administrateur existant reste administrateur sans réécriture", () => {
  assert.strictEqual(conn.prepare("SELECT role FROM users WHERE email = ?").get("deja@exemple.fr").role, "admin");
});

test("relancer l'amorçage ne promeut personne de plus", () => {
  const second = bootstrapAdmins();
  assert.strictEqual(second.promus, 0, "l'opération doit être sans effet la deuxième fois");
  assert.strictEqual(second.deja, 1, "le compte déjà promu doit être compté comme tel");
});

test("aucune rétrogradation : retirer la variable ne retire pas le rôle", () => {
  /* Une faute de frappe lors d'un déploiement ne doit jamais priver le
     propriétaire de son application. */
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "adminBootstrap.js"), "utf8");
  assert.ok(!/role\s*=\s*['"]free['"]/.test(src), "le service contient une rétrogradation");
  assert.ok(!/UPDATE users SET role[^)]*WHERE role = 'admin'/.test(src), "rétrogradation de masse détectée");
});

test("sans variable définie, aucune promotion — mais l'absence est SIGNALÉE", () => {
  /* Corrigé après coup : le service se taisait quand la variable était vide,
     et un silence au démarrage pouvait alors vouloir dire trois choses très
     différentes — code non déployé, variable absente, ou tout va bien. */
  const config = require("../src/config");
  const sauvegarde = config.adminEmails;
  config.adminEmails = [];
  const r = bootstrapAdmins();
  assert.strictEqual(r.promus, 0, "aucune promotion ne doit avoir lieu");
  assert.strictEqual(r.variableAbsente, true, "l'absence doit être remontée à l'appelant");
  config.adminEmails = sauvegarde;
});

test("l'état réel est journalisé, pour qu'on sache QUI est administrateur", () => {
  /* C'était la question de départ du propriétaire : il ne savait plus quelle
     adresse il avait promue, et rien ne permettait de le retrouver. */
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "adminBootstrap.js"), "utf8");
  assert.ok(src.includes("function journaliserEtat"), "aucun état journalisé");
  assert.ok(/SELECT email FROM users WHERE role = 'admin'/.test(src), "la liste des admins n'est pas lue");
  assert.ok(src.includes('logger.info("Administrateurs en base"'), "la liste n'est pas écrite dans les journaux");
  /* Et ce message doit sortir dans les DEUX cas : variable absente ou non. */
  const iVide = src.indexOf("variableAbsente");
  const avantVide = src.slice(Math.max(0, iVide - 400), iVide);
  assert.ok(avantVide.includes("journaliserEtat(conn)"), "l'état n'est pas journalisé quand la variable est absente");
});

test("le serveur écrit toujours la ligne d'amorçage", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/logger\.info\("Amorçage administrateurs", adminBootstrap\.bootstrapAdmins\(\)\)/.test(src),
    "la ligne doit être écrite inconditionnellement");
});

test("le démarrage n'est jamais empêché par un échec d'amorçage", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const i = src.indexOf("bootstrapAdmins()");
  const avant = src.slice(Math.max(0, i - 300), i);
  assert.ok(avant.includes("try {"), "l'appel doit être protégé : mieux vaut une app debout sans admin qu'une app à terre");
});

db.close();
fs.rmSync(dossier, { recursive: true, force: true });

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).\n`);
process.exit(failed ? 1 : 0);
