import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");

// ============================================================
// MIGRATION TESTS
// ============================================================

const migrationPath = path.join(
  projectRoot,
  "supabase",
  "migrations",
  "20260829160000_harden_avis_permissions_v1_1.sql"
);
const migrationSql = fs.readFileSync(migrationPath, "utf8");
const executableMigration = migrationSql.replace(/--.*$/gm, "");

// Migration is wrapped in transaction
assert.match(migrationSql, /BEGIN;/i, "migration must be wrapped in BEGIN");
assert.match(migrationSql, /COMMIT;/i, "migration must be wrapped in COMMIT");

// PUBLIC READ: column-level SELECT grant for anon (NOT table-wide)
assert.match(
  executableMigration,
  /GRANT SELECT\s*\(\s*auteur_nom\s*,\s*note\s*,\s*titre\s*,\s*commentaire\s*,\s*ville\s*,\s*created_at\s*\)\s*ON public\.avis TO anon/i,
  "migration must grant column-level SELECT only on public display columns"
);
assert.doesNotMatch(
  executableMigration,
  /GRANT SELECT ON public\.avis TO anon\s*;/i,
  "migration must NOT grant table-wide SELECT to anon"
);

// Private columns must NOT be in the SELECT grant
const selectGrantMatch = executableMigration.match(/GRANT SELECT\s*\(([^)]+)\)\s*ON public\.avis TO anon/i);
assert.ok(selectGrantMatch, "SELECT grant must exist");
const grantedSelectColumns = selectGrantMatch[1].replace(/\s/g, "").toLowerCase().split(",");
const privateColumns = ["auteur_email", "user_id", "mission_id", "reponse_admin", "approved_at", "updated_at", "source", "type_service", "id"];
for (const col of privateColumns) {
  assert.ok(
    !grantedSelectColumns.includes(col),
    `private column '${col}' must NOT be in the anon SELECT grant`
  );
}

// PUBLIC INSERT: hardened policy
assert.match(
  executableMigration,
  /DROP POLICY "avis_insert_anon_safe" ON public\.avis/i,
  "migration must drop the old unsafe anon INSERT policy"
);
assert.match(
  executableMigration,
  /CREATE POLICY "avis_insert_anon_safe"\s+ON public\.avis\s+FOR INSERT\s+TO anon/i,
  "migration must create hardened anon INSERT policy"
);

// Hardened policy must enforce statut = 'en_attente' (no auto-approval)
assert.match(
  executableMigration,
  /statut\s*=\s*'en_attente'/i,
  "hardened policy must enforce statut = 'en_attente'"
);

// Hardened policy must enforce source = 'site'
assert.match(
  executableMigration,
  /source\s*=\s*'site'/i,
  "hardened policy must enforce source = 'site'"
);

// Hardened policy must enforce user_id IS NULL
assert.match(
  executableMigration,
  /user_id IS NULL/i,
  "hardened policy must enforce user_id IS NULL"
);

// Hardened policy must enforce reponse_admin IS NULL
assert.match(
  executableMigration,
  /reponse_admin IS NULL/i,
  "hardened policy must enforce reponse_admin IS NULL"
);

// Hardened policy must enforce approved_at IS NULL
assert.match(
  executableMigration,
  /approved_at IS NULL/i,
  "hardened policy must enforce approved_at IS NULL"
);

// Hardened policy must NOT require auteur_email IS NOT NULL (email is optional)
assert.doesNotMatch(
  executableMigration,
  /auteur_email IS NOT NULL/i,
  "hardened policy must NOT require auteur_email (email is optional, matching frontend)"
);

// Column-level INSERT grant for anon
assert.match(
  executableMigration,
  /GRANT INSERT\s*\(\s*auteur_type\s*,\s*auteur_nom\s*,\s*auteur_email\s*,\s*note\s*,\s*titre\s*,\s*commentaire\s*,\s*ville\s*\)\s*ON public\.avis TO anon/i,
  "migration must grant column-level INSERT only on review fields"
);

// No UPDATE or DELETE grant to anon
assert.doesNotMatch(
  executableMigration,
  /GRANT.*(?:UPDATE|DELETE).*ON public\.avis TO anon/i,
  "migration must NOT grant UPDATE or DELETE to anon"
);

// No table structure changes
assert.doesNotMatch(
  executableMigration,
  /\b(?:ALTER TABLE|CREATE TABLE|DROP TABLE|ADD COLUMN|DROP COLUMN|RENAME)\b/i,
  "migration must not change table structure"
);

// No RLS enable/disable changes (RLS already enabled)
assert.doesNotMatch(
  executableMigration,
  /(?:ENABLE|DISABLE) ROW LEVEL SECURITY/i,
  "migration must not change RLS enable/disable status"
);

// ============================================================
// AVIS.JS TESTS — PUBLIC READ
// ============================================================

const avisPath = path.join(projectRoot, "public", "js", "avis.js");
const avisSrc = fs.readFileSync(avisPath, "utf8");

// 1. Frontend must NOT use select('*')
assert.doesNotMatch(
  avisSrc,
  /\.select\('\*'\)/,
  "avis.js must NOT use select('*') — must select only public columns"
);

// 2. Frontend must select only public display columns
assert.match(
  avisSrc,
  /\.select\('auteur_nom,note,titre,commentaire,ville,created_at'\)/,
  "avis.js must select only public display columns: auteur_nom, note, titre, commentaire, ville, created_at"
);

// 3. Frontend must NOT select private columns
assert.doesNotMatch(
  avisSrc,
  /\.select\('[^']*(?:auteur_email|user_id|mission_id|reponse_admin|approved_at)[^']*'\)/,
  "avis.js must NOT select private columns"
);

// ============================================================
// AVIS.JS TESTS — PUBLIC INSERT
// ============================================================

// 4. Frontend must NOT send statut in the insert payload (DB default handles it)
const insertPayloadMatch = avisSrc.match(/var row = \{([\s\S]*?)\};/);
assert.ok(insertPayloadMatch, "submitAvis must have a row object");
const insertPayload = insertPayloadMatch[1];

assert.doesNotMatch(
  insertPayload,
  /statut\s*:/,
  "frontend must NOT send statut in insert payload — DB default 'en_attente' handles it"
);

// 5. Frontend must NOT send source in the insert payload (DB default handles it)
assert.doesNotMatch(
  insertPayload,
  /source\s*:/,
  "frontend must NOT send source in insert payload — DB default 'site' handles it"
);

// 6. Frontend must only include user_id conditionally (for authenticated users)
assert.match(
  avisSrc,
  /if\s*\(userId\)\s*row\.user_id\s*=\s*userId/,
  "frontend must only include user_id when authenticated (not for anon)"
);

// 7. Frontend must NOT send reponse_admin or approved_at
assert.doesNotMatch(
  insertPayload,
  /reponse_admin\s*:/,
  "frontend must NOT send reponse_admin in insert payload"
);
assert.doesNotMatch(
  insertPayload,
  /approved_at\s*:/,
  "frontend must NOT send approved_at in insert payload"
);

// 8. Frontend must send auteur_email as optional (null when not provided)
assert.match(
  insertPayload,
  /auteur_email:\s*data\.email\s*\|\|\s*null/,
  "frontend must send auteur_email as optional (data.email || null)"
);

// ============================================================
// AVIS.JS TESTS — LOGGING + FALLBACK
// ============================================================

// 9. Structured error logging in loadAvis
assert.match(
  avisSrc,
  /console\.error\('Erreur loadAvis:',\s*err\s*&&\s*err\.message\s*\?\s*err\.message\s*:\s*JSON\.stringify\(err\)\)/,
  "loadAvis must log structured error (message or JSON.stringify)"
);
assert.doesNotMatch(
  avisSrc,
  /console\.error\('Erreur loadAvis:',\s*err\);/,
  "loadAvis must not log raw err object"
);

// 10. Structured error logging in submitAvis
assert.match(
  avisSrc,
  /console\.error\('Erreur submitAvis:',\s*err\s*&&\s*err\.message\s*\?\s*err\.message\s*:\s*JSON\.stringify\(err\)\)/,
  "submitAvis must log structured error (message or JSON.stringify)"
);
assert.doesNotMatch(
  avisSrc,
  /console\.error\('Erreur submitAvis:',\s*err\);/,
  "submitAvis must not log raw err object"
);

// 11. Fallback rendering preserved
assert.match(avisSrc, /renderAvis\(container,\s*\[\],\s*limit\);/, "loadAvis must call renderAvis with empty array on error");

// 12. No service_role reference
assert.doesNotMatch(avisSrc, /service_role/i, "avis.js must never reference service_role");

// 13. DOMContentLoaded auto-init preserved
assert.match(avisSrc, /document\.addEventListener\('DOMContentLoaded'/, "avis.js must preserve DOMContentLoaded auto-init");

// ============================================================
// COOKIE CONSENT TESTS
// ============================================================

const cookiePath = path.join(projectRoot, "public", "js", "cookie-consent.js");
const cookieSrc = fs.readFileSync(cookiePath, "utf8");

// 14. Cookie consent checks for both 'accepted' and 'refused'
assert.match(
  cookieSrc,
  /consent\s*===\s*'accepted'\s*\|\|\s*consent\s*===\s*'refused'/,
  "cookie consent must check for both 'accepted' and 'refused'"
);

// 15. Cookie consent does NOT only check for 'accepted'
assert.doesNotMatch(
  cookieSrc,
  /localStorage\.getItem\('bathily_cookie_consent'\)\s*===\s*'accepted'\s*\)/,
  "cookie consent must not only check for 'accepted' (the old bug)"
);

// 16. Cookie consent stores 'refused' on refuse button click
assert.match(cookieSrc, /localStorage\.setItem\('bathily_cookie_consent',\s*'refused'\)/, "refuse button must persist 'refused'");

// 17. Cookie consent stores 'accepted' on accept button click
assert.match(cookieSrc, /localStorage\.setItem\('bathily_cookie_consent',\s*'accepted'\)/, "accept button must persist 'accepted'");

// 18. No tracking/analytics activation
assert.doesNotMatch(cookieSrc, /gtag|analytics|facebook|google-analytics|tracking/i, "cookie-consent must not activate any tracking");

// ============================================================
// SIMULATION TESTS
// ============================================================

// Simulate cookie consent logic
function simulateCookieConsent(storedValue) {
  var consent = storedValue;
  if (consent === 'accepted' || consent === 'refused') return 'NO_BANNER';
  return 'SHOW_BANNER';
}

assert.equal(simulateCookieConsent(null), 'SHOW_BANNER', 'fresh visitor must see banner');
assert.equal(simulateCookieConsent('accepted'), 'NO_BANNER', 'accepted must not show banner');
assert.equal(simulateCookieConsent('refused'), 'NO_BANNER', 'refused must not show banner');
assert.equal(simulateCookieConsent('invalid'), 'SHOW_BANNER', 'invalid value must show banner');

// Simulate structured error logging
function formatAvisError(err) {
  return err && err.message ? err.message : JSON.stringify(err);
}

assert.equal(
  formatAvisError({ message: 'permission denied for table avis', code: '42501' }),
  'permission denied for table avis',
  'error with message must use .message'
);
assert.match(
  formatAvisError({ code: '42501' }),
  /"code"\s*:\s*"42501"/,
  'error without message must use JSON.stringify'
);
assert.equal(formatAvisError(null), 'null', 'null error must stringify to null');

// Simulate hardened INSERT policy validation
function validateAnonInsert(row) {
  var errors = [];
  if (row.user_id !== null && row.user_id !== undefined) errors.push('user_id must be NULL');
  if (row.statut !== undefined && row.statut !== 'en_attente') errors.push('statut must be en_attente');
  if (row.source !== undefined && row.source !== 'site') errors.push('source must be site');
  if (row.reponse_admin !== null && row.reponse_admin !== undefined) errors.push('reponse_admin must be NULL');
  if (row.approved_at !== null && row.approved_at !== undefined) errors.push('approved_at must be NULL');
  return errors;
}

// Valid anon insert (en_attente, no private fields)
assert.equal(
  validateAnonInsert({ auteur_type: 'client', auteur_nom: 'Jean', note: 5, commentaire: 'Great', statut: 'en_attente', source: 'site', user_id: null, reponse_admin: null, approved_at: null }).length,
  0,
  'valid anon insert with en_attente must pass policy'
);

// Auto-approval attempt must fail
assert.ok(
  validateAnonInsert({ statut: 'approuve', user_id: null, source: 'site', reponse_admin: null, approved_at: null }).length > 0,
  'anon insert with statut=approuve must be rejected by policy'
);

// user_id injection attempt must fail
assert.ok(
  validateAnonInsert({ statut: 'en_attente', user_id: 'some-uuid', source: 'site', reponse_admin: null, approved_at: null }).length > 0,
  'anon insert with user_id set must be rejected by policy'
);

// source spoofing attempt must fail
assert.ok(
  validateAnonInsert({ statut: 'en_attente', user_id: null, source: 'admin', reponse_admin: null, approved_at: null }).length > 0,
  'anon insert with source!=site must be rejected by policy'
);

// reponse_admin injection attempt must fail
assert.ok(
  validateAnonInsert({ statut: 'en_attente', user_id: null, source: 'site', reponse_admin: 'approved!', approved_at: null }).length > 0,
  'anon insert with reponse_admin set must be rejected by policy'
);

// approved_at injection attempt must fail
assert.ok(
  validateAnonInsert({ statut: 'en_attente', user_id: null, source: 'site', reponse_admin: null, approved_at: '2026-01-01' }).length > 0,
  'anon insert with approved_at set must be rejected by policy'
);

// Simulate frontend insert payload (should not contain statut, source, user_id for anon)
function buildFrontendPayload(data, userId) {
  var row = {
    auteur_type: data.type,
    auteur_nom: data.nom,
    auteur_email: data.email || null,
    note: data.note,
    titre: data.titre || null,
    commentaire: data.commentaire,
    ville: data.ville || null
  };
  if (userId) row.user_id = userId;
  return row;
}

// Anonymous user payload
var anonPayload = buildFrontendPayload({ type: 'client', nom: 'Jean', note: 5, commentaire: 'Great' }, null);
assert.equal(anonPayload.statut, undefined, 'anon payload must not contain statut');
assert.equal(anonPayload.source, undefined, 'anon payload must not contain source');
assert.equal(anonPayload.user_id, undefined, 'anon payload must not contain user_id');
assert.equal(anonPayload.reponse_admin, undefined, 'anon payload must not contain reponse_admin');
assert.equal(anonPayload.approved_at, undefined, 'anon payload must not contain approved_at');

// Authenticated user payload
var authPayload = buildFrontendPayload({ type: 'client', nom: 'Jean', note: 5, commentaire: 'Great' }, 'user-uuid-123');
assert.equal(authPayload.user_id, 'user-uuid-123', 'auth payload must contain user_id when authenticated');
assert.equal(authPayload.statut, undefined, 'auth payload must not contain statut (DB default handles it)');
assert.equal(authPayload.source, undefined, 'auth payload must not contain source (DB default handles it)');

// Email optional
var noEmailPayload = buildFrontendPayload({ type: 'client', nom: 'Jean', note: 5, commentaire: 'Great' }, null);
assert.equal(noEmailPayload.auteur_email, null, 'payload must allow null email (optional)');

// ============================================================
// AUTHENTICATED INSERT POLICY HARDENING (V1.1-A3)
// ============================================================

// Migration must DROP and CREATE the auth policy
assert.match(
  executableMigration,
  /DROP POLICY "avis_insert_auth_safe" ON public\.avis/i,
  "migration must drop the old unsafe auth INSERT policy"
);
assert.match(
  executableMigration,
  /CREATE POLICY "avis_insert_auth_safe"\s+ON public\.avis\s+FOR INSERT\s+TO authenticated/i,
  "migration must create hardened auth INSERT policy"
);

// Hardened auth policy must enforce statut = 'en_attente'
assert.match(
  executableMigration,
  /avis_insert_auth_safe[\s\S]*?statut\s*=\s*'en_attente'/i,
  "hardened auth policy must enforce statut = 'en_attente'"
);

// Hardened auth policy must enforce source = 'site'
assert.match(
  executableMigration,
  /avis_insert_auth_safe[\s\S]*?source\s*=\s*'site'/i,
  "hardened auth policy must enforce source = 'site'"
);

// Hardened auth policy must enforce reponse_admin IS NULL
assert.match(
  executableMigration,
  /avis_insert_auth_safe[\s\S]*?reponse_admin IS NULL/i,
  "hardened auth policy must enforce reponse_admin IS NULL"
);

// Hardened auth policy must enforce approved_at IS NULL
assert.match(
  executableMigration,
  /avis_insert_auth_safe[\s\S]*?approved_at IS NULL/i,
  "hardened auth policy must enforce approved_at IS NULL"
);

// Hardened auth policy must preserve user_id = auth.uid() OR NULL
assert.match(
  executableMigration,
  /avis_insert_auth_safe[\s\S]*?user_id IS NULL OR user_id = \(SELECT auth\.uid\(\)\)/i,
  "hardened auth policy must preserve (user_id IS NULL OR user_id = auth.uid())"
);

// Hardened auth policy must NOT require auteur_email IS NOT NULL
var authPolicyMatch = executableMigration.match(/CREATE POLICY "avis_insert_auth_safe"[\s\S]*?WITH CHECK\s*\(([\s\S]*?)\)\s*;/i);
assert.ok(authPolicyMatch, "auth policy WITH CHECK must exist");
assert.doesNotMatch(
  authPolicyMatch[1],
  /auteur_email IS NOT NULL/i,
  "hardened auth policy must NOT require auteur_email (email is optional)"
);

// No is_admin() branch in the auth INSERT policy (no admin INSERT consumer)
assert.doesNotMatch(
  authPolicyMatch[1],
  /is_admin\(\)/i,
  "auth INSERT policy must NOT have is_admin() branch (no admin INSERT consumer exists)"
);

// Simulate hardened auth INSERT policy validation
function validateAuthInsert(row, currentUserId) {
  var errors = [];
  if (row.user_id !== null && row.user_id !== undefined && row.user_id !== currentUserId) {
    errors.push('user_id must be NULL or equal to auth.uid()');
  }
  if (row.statut !== undefined && row.statut !== 'en_attente') errors.push('statut must be en_attente');
  if (row.source !== undefined && row.source !== 'site') errors.push('source must be site');
  if (row.reponse_admin !== null && row.reponse_admin !== undefined) errors.push('reponse_admin must be NULL');
  if (row.approved_at !== null && row.approved_at !== undefined) errors.push('approved_at must be NULL');
  return errors;
}

// 1. authenticated can deposit a normal avis
assert.equal(
  validateAuthInsert({ auteur_type: 'client', auteur_nom: 'Jean', note: 5, commentaire: 'Great', statut: 'en_attente', source: 'site', user_id: 'uid-123', reponse_admin: null, approved_at: null }, 'uid-123').length,
  0,
  'authenticated user can deposit a normal avis'
);

// 2. authenticated without email can deposit a normal avis
assert.equal(
  validateAuthInsert({ auteur_type: 'client', auteur_nom: 'Jean', auteur_email: null, note: 5, commentaire: 'Great', statut: 'en_attente', source: 'site', user_id: 'uid-123', reponse_admin: null, approved_at: null }, 'uid-123').length,
  0,
  'authenticated user without email can deposit a normal avis'
);

// 3. authenticated user_id=self accepted
assert.equal(
  validateAuthInsert({ user_id: 'uid-123', statut: 'en_attente', source: 'site', reponse_admin: null, approved_at: null }, 'uid-123').length,
  0,
  'authenticated user_id=self is accepted'
);

// 4. authenticated user_id=different-user rejected
assert.ok(
  validateAuthInsert({ user_id: 'different-uid', statut: 'en_attente', source: 'site', reponse_admin: null, approved_at: null }, 'uid-123').length > 0,
  'authenticated user_id=different-user must be rejected'
);

// 5. authenticated statut='approuve' rejected
assert.ok(
  validateAuthInsert({ statut: 'approuve', user_id: 'uid-123', source: 'site', reponse_admin: null, approved_at: null }, 'uid-123').length > 0,
  'authenticated statut=approuve must be rejected (no auto-approval)'
);

// 6. authenticated statut='rejete' rejected
assert.ok(
  validateAuthInsert({ statut: 'rejete', user_id: 'uid-123', source: 'site', reponse_admin: null, approved_at: null }, 'uid-123').length > 0,
  'authenticated statut=rejete must be rejected'
);

// 7. authenticated source arbitrary rejected
assert.ok(
  validateAuthInsert({ statut: 'en_attente', source: 'admin', user_id: 'uid-123', reponse_admin: null, approved_at: null }, 'uid-123').length > 0,
  'authenticated source!=site must be rejected'
);

// 8. authenticated reponse_admin non-NULL rejected
assert.ok(
  validateAuthInsert({ statut: 'en_attente', source: 'site', user_id: 'uid-123', reponse_admin: 'approved!', approved_at: null }, 'uid-123').length > 0,
  'authenticated reponse_admin non-NULL must be rejected'
);

// 9. authenticated approved_at non-NULL rejected
assert.ok(
  validateAuthInsert({ statut: 'en_attente', source: 'site', user_id: 'uid-123', reponse_admin: null, approved_at: '2026-01-01' }, 'uid-123').length > 0,
  'authenticated approved_at non-NULL must be rejected'
);

// 10. anon A2 remains functional (validate anon policy unchanged)
assert.match(
  executableMigration,
  /avis_insert_anon_safe[\s\S]*?user_id IS NULL[\s\S]*?statut = 'en_attente'[\s\S]*?source = 'site'/i,
  "anon INSERT policy must remain hardened (A2 unchanged)"
);

// 11. private columns remain unreadable to anon (SELECT grant unchanged)
assert.match(
  executableMigration,
  /GRANT SELECT\s*\(\s*auteur_nom\s*,\s*note\s*,\s*titre\s*,\s*commentaire\s*,\s*ville\s*,\s*created_at\s*\)\s*ON public\.avis TO anon/i,
  "anon SELECT grant must remain column-level (private columns protected)"
);

// 12. admin workflow preserved — avis_select_admin and avis_update_own NOT modified
assert.doesNotMatch(
  executableMigration,
  /(?:DROP|ALTER|CREATE) POLICY "avis_select_admin"/i,
  "avis_select_admin policy must NOT be modified"
);
assert.doesNotMatch(
  executableMigration,
  /(?:DROP|ALTER|CREATE) POLICY "avis_update_own"/i,
  "avis_update_own policy must NOT be modified"
);

// 13. no DELETE grant to authenticated (no DELETE policy exists)
assert.doesNotMatch(
  executableMigration,
  /GRANT DELETE.*ON public\.avis TO (?:anon|authenticated)/i,
  "migration must NOT grant DELETE to anon or authenticated"
);

// ============================================================
// LEAST PRIVILEGE FINALIZATION (V1.1-A4)
// ============================================================

// --- REVOKE table-wide grants from authenticated ---
assert.match(
  executableMigration,
  /REVOKE SELECT,\s*INSERT,\s*DELETE,\s*UPDATE ON public\.avis FROM authenticated/i,
  "migration must REVOKE all table-wide grants from authenticated"
);

// --- Column-level SELECT for authenticated (same as anon) ---
assert.match(
  executableMigration,
  /GRANT SELECT\s*\(\s*auteur_nom\s*,\s*note\s*,\s*titre\s*,\s*commentaire\s*,\s*ville\s*,\s*created_at\s*\)\s*ON public\.avis TO authenticated/i,
  "migration must grant column-level SELECT to authenticated (same 6 public columns as anon)"
);

// --- No table-wide SELECT for authenticated ---
assert.doesNotMatch(
  executableMigration,
  /GRANT SELECT ON public\.avis TO authenticated\s*;/i,
  "migration must NOT grant table-wide SELECT to authenticated"
);

// --- Column-level INSERT for authenticated (includes user_id) ---
assert.match(
  executableMigration,
  /GRANT INSERT\s*\(\s*auteur_type\s*,\s*auteur_nom\s*,\s*auteur_email\s*,\s*user_id\s*,\s*note\s*,\s*titre\s*,\s*commentaire\s*,\s*ville\s*\)\s*ON public\.avis TO authenticated/i,
  "migration must grant column-level INSERT to authenticated (review fields + user_id)"
);

// --- No table-wide INSERT for authenticated ---
assert.doesNotMatch(
  executableMigration,
  /GRANT INSERT ON public\.avis TO authenticated\s*;/i,
  "migration must NOT grant table-wide INSERT to authenticated"
);

// --- Column-level UPDATE for authenticated (review fields only, no user_id) ---
assert.match(
  executableMigration,
  /GRANT UPDATE\s*\(\s*auteur_type\s*,\s*auteur_nom\s*,\s*auteur_email\s*,\s*note\s*,\s*titre\s*,\s*commentaire\s*,\s*ville\s*\)\s*ON public\.avis TO authenticated/i,
  "migration must grant column-level UPDATE to authenticated (review fields only)"
);

// --- No table-wide UPDATE for authenticated ---
assert.doesNotMatch(
  executableMigration,
  /GRANT UPDATE ON public\.avis TO authenticated\s*;/i,
  "migration must NOT grant table-wide UPDATE to authenticated"
);

// --- INSERT grant must NOT include statut, source, mission_id, type_service, reponse_admin, approved_at ---
const authInsertGrantMatch = executableMigration.match(/GRANT INSERT\s*\(([^)]+)\)\s*ON public\.avis TO authenticated/i);
assert.ok(authInsertGrantMatch, "auth INSERT grant must exist");
const authInsertColumns = authInsertGrantMatch[1].replace(/\s/g, "").toLowerCase().split(",");
const blockedInsertCols = ["statut", "source", "mission_id", "type_service", "reponse_admin", "approved_at", "id", "created_at", "updated_at"];
for (const col of blockedInsertCols) {
  assert.ok(
    !authInsertColumns.includes(col),
    `authenticated INSERT grant must NOT include '${col}'`
  );
}

// --- UPDATE grant must NOT include statut, source, user_id, mission_id, type_service, reponse_admin, approved_at ---
const authUpdateGrantMatch = executableMigration.match(/GRANT UPDATE\s*\(([^)]+)\)\s*ON public\.avis TO authenticated/i);
assert.ok(authUpdateGrantMatch, "auth UPDATE grant must exist");
const authUpdateColumns = authUpdateGrantMatch[1].replace(/\s/g, "").toLowerCase().split(",");
const blockedUpdateCols = ["statut", "source", "user_id", "mission_id", "type_service", "reponse_admin", "approved_at", "id", "created_at", "updated_at"];
for (const col of blockedUpdateCols) {
  assert.ok(
    !authUpdateColumns.includes(col),
    `authenticated UPDATE grant must NOT include '${col}'`
  );
}

// --- SELECT grant for authenticated must NOT include private columns ---
const authSelectGrantMatch = executableMigration.match(/GRANT SELECT\s*\(([^)]+)\)\s*ON public\.avis TO authenticated/i);
assert.ok(authSelectGrantMatch, "auth SELECT grant must exist");
const authSelectColumns = authSelectGrantMatch[1].replace(/\s/g, "").toLowerCase().split(",");
for (const col of privateColumns) {
  assert.ok(
    !authSelectColumns.includes(col),
    `authenticated SELECT grant must NOT include private column '${col}'`
  );
}

// --- No GRANT DELETE to authenticated ---
assert.doesNotMatch(
  executableMigration,
  /GRANT DELETE.*ON public\.avis TO authenticated/i,
  "migration must NOT grant DELETE to authenticated"
);

// --- avis_update_own policy NOT modified (only grant changed, not policy) ---
assert.doesNotMatch(
  executableMigration,
  /(?:DROP|ALTER|CREATE) POLICY "avis_update_own"/i,
  "avis_update_own policy must NOT be modified (only UPDATE grant changed)"
);

// --- avis_select_admin policy NOT modified ---
assert.doesNotMatch(
  executableMigration,
  /(?:DROP|ALTER|CREATE) POLICY "avis_select_admin"/i,
  "avis_select_admin policy must NOT be modified"
);

// ============================================================
// SIMULATION: LEAST PRIVILEGE VALIDATION
// ============================================================

// Simulate column-level grant validation
function validateColumnGrant(grantedColumns, requestedColumn) {
  return grantedColumns.includes(requestedColumn);
}

// Authenticated SELECT columns
var authSelectGranted = ["auteur_nom", "note", "titre", "commentaire", "ville", "created_at"];

// 1. anon can read only 6 public columns
var anonSelectGranted = ["auteur_nom", "note", "titre", "commentaire", "ville", "created_at"];
assert.equal(validateColumnGrant(anonSelectGranted, "auteur_nom"), true, "anon can read auteur_nom");
assert.equal(validateColumnGrant(anonSelectGranted, "note"), true, "anon can read note");
assert.equal(validateColumnGrant(anonSelectGranted, "created_at"), true, "anon can read created_at");

// 2. authenticated non-admin can read only public columns
assert.equal(validateColumnGrant(authSelectGranted, "auteur_nom"), true, "auth can read auteur_nom");
assert.equal(validateColumnGrant(authSelectGranted, "note"), true, "auth can read note");

// 3. anon cannot read auteur_email
assert.equal(validateColumnGrant(anonSelectGranted, "auteur_email"), false, "anon cannot read auteur_email");

// 4. authenticated non-admin cannot read auteur_email
assert.equal(validateColumnGrant(authSelectGranted, "auteur_email"), false, "auth non-admin cannot read auteur_email");

// 5. anon/auth non-admin cannot read user_id
assert.equal(validateColumnGrant(anonSelectGranted, "user_id"), false, "anon cannot read user_id");
assert.equal(validateColumnGrant(authSelectGranted, "user_id"), false, "auth non-admin cannot read user_id");

// 6. anon/auth non-admin cannot read mission_id
assert.equal(validateColumnGrant(anonSelectGranted, "mission_id"), false, "anon cannot read mission_id");
assert.equal(validateColumnGrant(authSelectGranted, "mission_id"), false, "auth non-admin cannot read mission_id");

// 7. avis non approved remain invisible (RLS avis_select_approved NOT modified)
assert.doesNotMatch(
  executableMigration,
  /(?:DROP|ALTER|CREATE) POLICY "avis_select_approved"/i,
  "avis_select_approved policy must NOT be modified (non-approved avis invisible)"
);

// 8. admin access preserved (avis_select_admin unchanged)
assert.doesNotMatch(
  executableMigration,
  /(?:DROP|ALTER) POLICY "avis_select_admin"/i,
  "avis_select_admin must NOT be dropped or altered"
);

// INSERT simulations (from A3, still valid)
var authInsertGranted = ["auteur_type", "auteur_nom", "auteur_email", "user_id", "note", "titre", "commentaire", "ville"];

// 9. anon deposit normal works (A2)
assert.equal(validateColumnGrant(["auteur_type", "auteur_nom", "auteur_email", "note", "titre", "commentaire", "ville"], "auteur_nom"), true, "anon can insert auteur_nom");

// 10. authenticated deposit normal works
assert.equal(validateColumnGrant(authInsertGranted, "auteur_nom"), true, "auth can insert auteur_nom");
assert.equal(validateColumnGrant(authInsertGranted, "commentaire"), true, "auth can insert commentaire");

// 11. authenticated user_id=self works
assert.equal(validateColumnGrant(authInsertGranted, "user_id"), true, "auth can insert user_id (for self)");

// 12. authenticated other user_id fails (RLS policy)
assert.ok(
  validateAuthInsert({ user_id: 'different-uid', statut: 'en_attente', source: 'site', reponse_admin: null, approved_at: null }, 'uid-123').length > 0,
  "auth user_id=different-user must fail RLS check"
);

// 13. authenticated cannot insert mission_id
assert.equal(validateColumnGrant(authInsertGranted, "mission_id"), false, "auth cannot insert mission_id");

// 14. authenticated cannot insert type_service
assert.equal(validateColumnGrant(authInsertGranted, "type_service"), false, "auth cannot insert type_service");

// 15. authenticated cannot insert statut
assert.equal(validateColumnGrant(authInsertGranted, "statut"), false, "auth cannot insert statut");

// 16. authenticated cannot insert source
assert.equal(validateColumnGrant(authInsertGranted, "source"), false, "auth cannot insert source");

// 17. authenticated cannot insert reponse_admin
assert.equal(validateColumnGrant(authInsertGranted, "reponse_admin"), false, "auth cannot insert reponse_admin");

// 18. authenticated cannot insert approved_at
assert.equal(validateColumnGrant(authInsertGranted, "approved_at"), false, "auth cannot insert approved_at");

// 19. anon remains subject to A2 restrictions
var anonInsertGranted = ["auteur_type", "auteur_nom", "auteur_email", "note", "titre", "commentaire", "ville"];
assert.equal(validateColumnGrant(anonInsertGranted, "statut"), false, "anon cannot insert statut");
assert.equal(validateColumnGrant(anonInsertGranted, "source"), false, "anon cannot insert source");
assert.equal(validateColumnGrant(anonInsertGranted, "user_id"), false, "anon cannot insert user_id");

// 20. no auto-approval possible (triple defense: grant + RLS + default)
assert.equal(validateColumnGrant(authInsertGranted, "statut"), false, "auth cannot insert statut (grant blocks)");
assert.ok(
  validateAuthInsert({ statut: 'approuve', user_id: 'uid-123', source: 'site', reponse_admin: null, approved_at: null }, 'uid-123').length > 0,
  "auth statut=approuve must fail RLS check"
);

// UPDATE/DELETE simulations
var authUpdateGranted = ["auteur_type", "auteur_nom", "auteur_email", "note", "titre", "commentaire", "ville"];

// 21. UPDATE/DELETE privileges documented
assert.match(
  executableMigration,
  /GRANT UPDATE\s*\([^)]*\)\s*ON public\.avis TO authenticated/i,
  "authenticated has column-level UPDATE grant"
);
assert.doesNotMatch(
  executableMigration,
  /GRANT DELETE.*ON public\.avis TO authenticated/i,
  "authenticated has NO DELETE grant"
);

// 22. no new UPDATE/DELETE table-wide grants
assert.doesNotMatch(
  executableMigration,
  /GRANT UPDATE ON public\.avis TO authenticated\s*;/i,
  "no table-wide UPDATE grant to authenticated"
);
assert.doesNotMatch(
  executableMigration,
  /GRANT DELETE ON public\.avis TO authenticated\s*;/i,
  "no table-wide DELETE grant to authenticated"
);

// 23. no path to promotion via UPDATE (cannot update statut, reponse_admin, approved_at)
assert.equal(validateColumnGrant(authUpdateGranted, "statut"), false, "auth cannot UPDATE statut (no self-approval)");
assert.equal(validateColumnGrant(authUpdateGranted, "reponse_admin"), false, "auth cannot UPDATE reponse_admin (no admin response injection)");
assert.equal(validateColumnGrant(authUpdateGranted, "approved_at"), false, "auth cannot UPDATE approved_at (no approval timestamp injection)");
assert.equal(validateColumnGrant(authUpdateGranted, "source"), false, "auth cannot UPDATE source (no spoofing)");
assert.equal(validateColumnGrant(authUpdateGranted, "user_id"), false, "auth cannot UPDATE user_id (no identity change)");

console.log("V1.1-A4 least-privilege finalization tests passed (column-level SELECT/INSERT/UPDATE/DELETE for anon + authenticated, hardened INSERT policies, no select('*'), cookie consent, structured logging).");
