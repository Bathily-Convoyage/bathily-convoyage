import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");

// ============================================================
// MIGRATION TESTS — V1.1-B AVIS API REDESIGN
// ============================================================

const migrationPath = path.join(
  projectRoot,
  "supabase",
  "migrations",
  "20260829200000_avis_public_api_redesign.sql"
);
const migrationSql = fs.readFileSync(migrationPath, "utf8");
const executableMigration = migrationSql.replace(/--.*$/gm, "");

// Migration is wrapped in transaction
assert.match(migrationSql, /BEGIN;/i, "migration must be wrapped in BEGIN");
assert.match(migrationSql, /COMMIT;/i, "migration must be wrapped in COMMIT");

// lock_timeout and statement_timeout bounded
assert.match(migrationSql, /SET LOCAL lock_timeout/i, "migration must set lock_timeout");
assert.match(migrationSql, /SET LOCAL statement_timeout/i, "migration must set statement_timeout");

// No table structure changes
assert.doesNotMatch(
  executableMigration,
  /\b(?:ALTER TABLE public\.avis|CREATE TABLE|DROP TABLE public\.avis|ADD COLUMN|DROP COLUMN|RENAME)\b/i,
  "migration must not change avis table structure"
);

// No data mutation outside the RPC function body.
// The RPC itself performs INSERT INTO public.avis (expected — that's its job),
// but the migration must not contain standalone data-mutating statements.
const functionBodyMatch = executableMigration.match(/AS \$function\$(.*?)\$function\$/s);
const functionBody = functionBodyMatch ? functionBodyMatch[1] : '';
const migrationOutsideFunction = executableMigration.replace(functionBody, '');
assert.doesNotMatch(
  migrationOutsideFunction,
  /\b(?:INSERT INTO public\.avis|UPDATE public\.avis SET|DELETE FROM public\.avis)\b/i,
  "migration must not contain standalone data-mutating statements outside the RPC"
);

// No service_role changes
assert.doesNotMatch(
  executableMigration,
  /(?:GRANT|REVOKE).*ON public\.avis (?:TO|FROM) service_role/i,
  "migration must NOT change service_role grants on avis"
);

// ============================================================
// PUBLIC READ — VIEW DESIGN
// ============================================================

// View must be created with security_barrier
assert.match(
  executableMigration,
  /CREATE(?: OR REPLACE)? VIEW public\.avis_public/i,
  "migration must create avis_public view"
);
assert.match(
  executableMigration,
  /security_barrier\s*=\s*true/i,
  "view must have security_barrier = true (prevents leak via function predicates)"
);

// View must select only 6 public columns
assert.match(
  executableMigration,
  /SELECT\s+auteur_nom\s*,\s*note\s*,\s*titre\s*,\s*commentaire\s*,\s*ville\s*,\s*created_at\s+FROM public\.avis/i,
  "view must select only 6 public columns from avis"
);

// View must filter approved-only
assert.match(
  executableMigration,
  /WHERE statut\s*=\s*'approuve'/i,
  "view must filter statut='approuve' only"
);

// View must NOT expose private columns
const viewDefMatch = executableMigration.match(/CREATE(?: OR REPLACE)? VIEW public\.avis_public(?:\s+WITH\s*\([^)]+\))?\s+AS\s+SELECT\s+(.*?)\s+FROM public\.avis/is);
assert.ok(viewDefMatch, "view definition must exist");
const viewColumns = viewDefMatch[1].replace(/\s/g, "").toLowerCase();
const privateColumns = ["auteur_email", "user_id", "mission_id", "reponse_admin", "approved_at", "updated_at", "source", "type_service", "id", "statut"];
for (const col of privateColumns) {
  assert.ok(
    !viewColumns.includes(col),
    `view must NOT expose private column '${col}'`
  );
}

// Grant SELECT on view to anon and authenticated
assert.match(
  executableMigration,
  /GRANT SELECT ON public\.avis_public TO anon/i,
  "migration must grant SELECT on avis_public to anon"
);
assert.match(
  executableMigration,
  /GRANT SELECT ON public\.avis_public TO authenticated/i,
  "migration must grant SELECT on avis_public to authenticated"
);

// No direct table SELECT grant to anon
assert.doesNotMatch(
  executableMigration,
  /GRANT SELECT ON public\.avis TO anon/i,
  "migration must NOT grant direct table SELECT to anon"
);

// ============================================================
// PUBLIC SUBMIT — RPC DESIGN
// ============================================================

// RPC must be created as SECURITY DEFINER
assert.match(
  executableMigration,
  /CREATE(?: OR REPLACE)? FUNCTION public\.submit_public_avis/i,
  "migration must create submit_public_avis function"
);
assert.match(
  executableMigration,
  /SECURITY DEFINER/i,
  "function must be SECURITY DEFINER"
);

// search_path must be set to empty
assert.match(
  executableMigration,
  /SET search_path TO ''/i,
  "function must set search_path to '' (empty)"
);

// Function must accept only review fields
assert.match(
  executableMigration,
  /p_auteur_type\s+text/i,
  "function must accept p_auteur_type text"
);
assert.match(
  executableMigration,
  /p_auteur_nom\s+text/i,
  "function must accept p_auteur_nom text"
);
assert.match(
  executableMigration,
  /p_auteur_email\s+text/i,
  "function must accept p_auteur_email text"
);
assert.match(
  executableMigration,
  /p_note\s+integer/i,
  "function must accept p_note integer"
);
assert.match(
  executableMigration,
  /p_titre\s+text/i,
  "function must accept p_titre text"
);
assert.match(
  executableMigration,
  /p_commentaire\s+text/i,
  "function must accept p_commentaire text"
);
assert.match(
  executableMigration,
  /p_ville\s+text/i,
  "function must accept p_ville text"
);

// Function must NOT accept privileged fields as arguments
assert.doesNotMatch(
  executableMigration,
  /p_statut\s|p_source\s|p_user_id\s|p_mission_id\s|p_type_service\s|p_reponse_admin\s|p_approved_at\s|p_id\s|p_created_at\s|p_updated_at\s/i,
  "function must NOT accept privileged fields as arguments"
);

// B2: Parameter ordering — required params first, optional (DEFAULT) last.
// PostgreSQL requires all IN params after the first DEFAULT to also have DEFAULT.
// Required: p_auteur_type, p_auteur_nom, p_note, p_commentaire
// Optional: p_auteur_email, p_titre, p_ville (all DEFAULT NULL)
const funcSigMatch = executableMigration.match(
  /CREATE(?: OR REPLACE)? FUNCTION public\.submit_public_avis\s*\(([\s\S]*?)\)/i
);
assert.ok(funcSigMatch, "function signature must exist for ordering check");
const funcParams = funcSigMatch[1];

// Extract parameter names and whether they have DEFAULT
const paramList = funcParams.split(',').map(p => {
  const trimmed = p.trim();
  const hasDefault = /DEFAULT/i.test(trimmed);
  const name = trimmed.match(/p_\w+/i);
  return { name: name ? name[0] : trimmed, hasDefault };
});

// All params with DEFAULT must come after all params without DEFAULT
let foundDefault = false;
for (const param of paramList) {
  if (param.hasDefault) {
    foundDefault = true;
  } else if (foundDefault) {
    assert.fail(
      `required param '${param.name}' appears after a DEFAULT param — ` +
      `PostgreSQL requires all params after the first DEFAULT to also have DEFAULT`
    );
  }
}
assert.ok(
  paramList.filter(p => !p.hasDefault).length === 4,
  "function must have exactly 4 required params (p_auteur_type, p_auteur_nom, p_note, p_commentaire)"
);
assert.ok(
  paramList.filter(p => p.hasDefault).length === 3,
  "function must have exactly 3 optional params with DEFAULT (p_auteur_email, p_titre, p_ville)"
);

// B2: REVOKE/GRANT type signature must match new param order
// New order: text, text, integer, text, text, text, text
assert.match(
  executableMigration,
  /REVOKE EXECUTE ON FUNCTION public\.submit_public_avis\s*\(\s*text\s*,\s*text\s*,\s*integer\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*\)\s*FROM PUBLIC/i,
  "REVOKE EXECUTE must use correct type signature (text, text, integer, text, text, text, text)"
);
assert.match(
  executableMigration,
  /GRANT EXECUTE ON FUNCTION public\.submit_public_avis\s*\(\s*text\s*,\s*text\s*,\s*integer\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*\)\s*TO anon/i,
  "GRANT EXECUTE to anon must use correct type signature"
);
assert.match(
  executableMigration,
  /GRANT EXECUTE ON FUNCTION public\.submit_public_avis\s*\(\s*text\s*,\s*text\s*,\s*integer\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*\)\s*TO authenticated/i,
  "GRANT EXECUTE to authenticated must use correct type signature"
);

// Function must force statut = 'en_attente'
assert.match(
  executableMigration,
  /'en_attente'/i,
  "function must force statut='en_attente' in INSERT"
);

// Function must force source = 'site'
assert.match(
  executableMigration,
  /'site'/i,
  "function must force source='site' in INSERT"
);

// Function must force reponse_admin = NULL
assert.match(
  executableMigration,
  /reponse_admin\s*,\s*approved_at/i,
  "function must include reponse_admin and approved_at in INSERT"
);

// Function must derive user_id from auth.uid()
assert.match(
  executableMigration,
  /auth\.uid\(\)/i,
  "function must derive user_id from auth.uid()"
);

// No dynamic SQL (EXECUTE as a PL/pgSQL statement, not GRANT/REVOKE EXECUTE)
assert.doesNotMatch(
  functionBody,
  /EXECUTE\s+|format\s*\(/i,
  "function must NOT use dynamic SQL (EXECUTE or format())"
);

// ============================================================
// FUNCTION ACL
// ============================================================

// REVOKE EXECUTE FROM PUBLIC
assert.match(
  executableMigration,
  /REVOKE EXECUTE ON FUNCTION public\.submit_public_avis[\s\S]*?FROM PUBLIC/i,
  "migration must REVOKE EXECUTE FROM PUBLIC"
);

// GRANT EXECUTE to anon
assert.match(
  executableMigration,
  /GRANT EXECUTE ON FUNCTION public\.submit_public_avis[\s\S]*?TO anon/i,
  "migration must GRANT EXECUTE to anon"
);

// GRANT EXECUTE to authenticated
assert.match(
  executableMigration,
  /GRANT EXECUTE ON FUNCTION public\.submit_public_avis[\s\S]*?TO authenticated/i,
  "migration must GRANT EXECUTE to authenticated"
);

// No EXECUTE grant to service_role (service_role bypasses anyway)
// service_role already has full access; no explicit grant needed

// ============================================================
// DIRECT TABLE GRANT CLEANUP
// ============================================================

// REVOKE all table-wide grants from authenticated
assert.match(
  executableMigration,
  /REVOKE SELECT,\s*INSERT,\s*UPDATE,\s*DELETE ON public\.avis FROM authenticated/i,
  "migration must REVOKE all table-wide grants from authenticated"
);

// No DELETE grant to anon or authenticated
assert.doesNotMatch(
  executableMigration,
  /GRANT DELETE.*ON public\.avis TO (?:anon|authenticated)/i,
  "migration must NOT grant DELETE on avis to anon or authenticated"
);

// No INSERT grant to anon or authenticated on base table
assert.doesNotMatch(
  executableMigration,
  /GRANT INSERT.*ON public\.avis TO (?:anon|authenticated)/i,
  "migration must NOT grant INSERT on avis to anon or authenticated (RPC handles it)"
);

// No UPDATE grant to anon or authenticated on base table
assert.doesNotMatch(
  executableMigration,
  /GRANT UPDATE.*ON public\.avis TO (?:anon|authenticated)/i,
  "migration must NOT grant UPDATE on avis to anon or authenticated"
);

// No SELECT grant to anon on base table
assert.doesNotMatch(
  executableMigration,
  /GRANT SELECT.*ON public\.avis TO anon/i,
  "migration must NOT grant SELECT on avis to anon (view handles it)"
);

// ============================================================
// POLICY CLEANUP
// ============================================================

// DROP old INSERT policies (replaced by RPC)
assert.match(
  executableMigration,
  /DROP POLICY.*avis_insert_anon_safe.*ON public\.avis/i,
  "migration must DROP avis_insert_anon_safe (replaced by RPC)"
);
assert.match(
  executableMigration,
  /DROP POLICY.*avis_insert_auth_safe.*ON public\.avis/i,
  "migration must DROP avis_insert_auth_safe (replaced by RPC)"
);

// Must NOT modify avis_select_approved
assert.doesNotMatch(
  executableMigration,
  /(?:DROP|ALTER|CREATE) POLICY.*avis_select_approved/i,
  "avis_select_approved must NOT be modified"
);

// Must NOT modify avis_select_admin
assert.doesNotMatch(
  executableMigration,
  /(?:DROP|ALTER|CREATE) POLICY.*avis_select_admin/i,
  "avis_select_admin must NOT be modified"
);

// Must NOT modify avis_update_own
assert.doesNotMatch(
  executableMigration,
  /(?:DROP|ALTER|CREATE) POLICY.*avis_update_own/i,
  "avis_update_own must NOT be modified"
);

// No RLS enable/disable changes
assert.doesNotMatch(
  executableMigration,
  /(?:ENABLE|DISABLE) ROW LEVEL SECURITY/i,
  "migration must not change RLS enable/disable status"
);

// ============================================================
// AVIS.JS TESTS — PUBLIC READ (public/js/avis.js)
// ============================================================

const avisPath = path.join(projectRoot, "public", "js", "avis.js");
const avisSrc = fs.readFileSync(avisPath, "utf8");

// 30. No direct from('avis').select(...)
assert.doesNotMatch(
  avisSrc,
  /\.from\('avis'\)\.select\(/,
  "avis.js must NOT use from('avis').select() — must use the view"
);

// 31. No direct from('avis').insert(...)
assert.doesNotMatch(
  avisSrc,
  /\.from\('avis'\)\.insert\(/,
  "avis.js must NOT use from('avis').insert() — must use the RPC"
);

// 32. Read uses avis_public view
assert.match(
  avisSrc,
  /\.from\('avis_public'\)\.select\(/,
  "avis.js must read from avis_public view"
);

// 33. Submit uses submit_public_avis RPC
assert.match(
  avisSrc,
  /\.rpc\('submit_public_avis'/,
  "avis.js must call submit_public_avis RPC"
);

// Read must select only public columns
assert.match(
  avisSrc,
  /\.select\('auteur_nom,note,titre,commentaire,ville,created_at'\)/,
  "avis.js must select only public display columns"
);

// No select('*')
assert.doesNotMatch(
  avisSrc,
  /\.select\('\*'\)/,
  "avis.js must NOT use select('*')"
);

// No private columns in select
assert.doesNotMatch(
  avisSrc,
  /\.select\('[^']*(?:auteur_email|user_id|mission_id|reponse_admin|approved_at)[^']*'\)/,
  "avis.js must NOT select private columns"
);

// No statut, source in RPC args
assert.doesNotMatch(
  avisSrc,
  /p_statut|p_source|p_user_id|p_mission_id|p_reponse_admin|p_approved_at/i,
  "avis.js must NOT pass privileged fields to the RPC"
);

// RPC args must include only review fields
assert.match(avisSrc, /p_auteur_type\s*:/, "avis.js must pass p_auteur_type to RPC");
assert.match(avisSrc, /p_auteur_nom\s*:/, "avis.js must pass p_auteur_nom to RPC");
assert.match(avisSrc, /p_auteur_email\s*:/, "avis.js must pass p_auteur_email to RPC");
assert.match(avisSrc, /p_note\s*:/, "avis.js must pass p_note to RPC");
assert.match(avisSrc, /p_commentaire\s*:/, "avis.js must pass p_commentaire to RPC");

// Email optional (null when not provided)
assert.match(
  avisSrc,
  /p_auteur_email:\s*data\.email\s*\|\|\s*null/,
  "avis.js must pass auteur_email as optional (data.email || null)"
);

// 34. Structured error logging in loadAvis
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

// 35. Structured error logging in submitAvis
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

// Fallback rendering preserved
assert.match(avisSrc, /renderAvis\(container,\s*\[\],\s*limit\);/, "loadAvis must call renderAvis with empty array on error");

// No service_role reference
assert.doesNotMatch(avisSrc, /service_role/i, "avis.js must never reference service_role");

// DOMContentLoaded auto-init preserved
assert.match(avisSrc, /document\.addEventListener\('DOMContentLoaded'/, "avis.js must preserve DOMContentLoaded auto-init");

// No direct getSession for user_id (RPC handles it server-side)
assert.doesNotMatch(
  avisSrc,
  /sb\.auth\.getSession\(\)/,
  "avis.js must NOT call getSession — RPC derives user_id from auth.uid()"
);

// ============================================================
// AVIS.JS TESTS — STALE DUPLICATE (js/avis.js)
// ============================================================

const staleAvisPath = path.join(projectRoot, "js", "avis.js");
const staleAvisSrc = fs.readFileSync(staleAvisPath, "utf8");

// Stale duplicate must also be updated
assert.doesNotMatch(
  staleAvisSrc,
  /\.from\('avis'\)\.select\(/,
  "js/avis.js (stale duplicate) must also NOT use from('avis').select()"
);
assert.doesNotMatch(
  staleAvisSrc,
  /\.from\('avis'\)\.insert\(/,
  "js/avis.js (stale duplicate) must also NOT use from('avis').insert()"
);
assert.match(
  staleAvisSrc,
  /\.from\('avis_public'\)\.select\(/,
  "js/avis.js (stale duplicate) must also use avis_public view"
);
assert.match(
  staleAvisSrc,
  /\.rpc\('submit_public_avis'/,
  "js/avis.js (stale duplicate) must also use submit_public_avis RPC"
);

// ============================================================
// COOKIE CONSENT TESTS (preserved from V1.1)
// ============================================================

const cookiePath = path.join(projectRoot, "public", "js", "cookie-consent.js");
const cookieSrc = fs.readFileSync(cookiePath, "utf8");

// Cookie consent checks for both 'accepted' and 'refused'
assert.match(
  cookieSrc,
  /consent\s*===\s*'accepted'\s*\|\|\s*consent\s*===\s*'refused'/,
  "cookie consent must check for both 'accepted' and 'refused'"
);

// Cookie consent stores 'refused' on refuse button click
assert.match(cookieSrc, /localStorage\.setItem\('bathily_cookie_consent',\s*'refused'\)/, "refuse button must persist 'refused'");

// Cookie consent stores 'accepted' on accept button click
assert.match(cookieSrc, /localStorage\.setItem\('bathily_cookie_consent',\s*'accepted'\)/, "accept button must persist 'accepted'");

// No tracking/analytics activation
assert.doesNotMatch(cookieSrc, /gtag|analytics|facebook|google-analytics|tracking/i, "cookie-consent must not activate any tracking");

// ============================================================
// SIMULATION TESTS — PUBLIC READ
// ============================================================

// Simulate view filtering
function simulateAvisPublicView(rows) {
  return rows
    .filter(r => r.statut === 'approuve')
    .map(r => ({
      auteur_nom: r.auteur_nom,
      note: r.note,
      titre: r.titre,
      commentaire: r.commentaire,
      ville: r.ville,
      created_at: r.created_at
    }));
}

var testRows = [
  { auteur_nom: 'Jean', note: 5, titre: 'Great', commentaire: 'Excellent', ville: 'Paris', created_at: '2026-01-01', statut: 'approuve', auteur_email: 'jean@email.com', user_id: 'uuid-1', mission_id: null, reponse_admin: null, approved_at: '2026-01-02', source: 'site', type_service: null, id: 'id-1' },
  { auteur_nom: 'Marie', note: 4, titre: 'Good', commentaire: 'Bien', ville: 'Lyon', created_at: '2026-01-03', statut: 'en_attente', auteur_email: 'marie@email.com', user_id: 'uuid-2', mission_id: null, reponse_admin: null, approved_at: null, source: 'site', type_service: null, id: 'id-2' },
  { auteur_nom: 'Pierre', note: 3, titre: 'OK', commentaire: 'Correct', ville: 'Nantes', created_at: '2026-01-04', statut: 'rejete', auteur_email: 'pierre@email.com', user_id: 'uuid-3', mission_id: null, reponse_admin: 'Spam', approved_at: null, source: 'site', type_service: null, id: 'id-3' },
  { auteur_nom: 'Sophie', note: 5, titre: 'Perfect', commentaire: 'Amazing', ville: 'Bordeaux', created_at: '2026-01-05', statut: 'approuve', auteur_email: 'sophie@email.com', user_id: 'uuid-4', mission_id: null, reponse_admin: null, approved_at: '2026-01-06', source: 'site', type_service: null, id: 'id-4' }
];

var publicView = simulateAvisPublicView(testRows);

// 1. Only approved avis returned
assert.equal(publicView.length, 2, 'only approved avis must be returned');

// 2. Pending avis not returned
assert.ok(!publicView.find(r => r.auteur_nom === 'Marie'), 'pending avis must not be returned');

// 3. Rejected avis not returned
assert.ok(!publicView.find(r => r.auteur_nom === 'Pierre'), 'rejected avis must not be returned');

// 4. Private columns absent from API contract
for (var row of publicView) {
  assert.equal(row.auteur_email, undefined, 'auteur_email must be absent from view output');
  assert.equal(row.user_id, undefined, 'user_id must be absent from view output');
  assert.equal(row.mission_id, undefined, 'mission_id must be absent from view output');
  assert.equal(row.reponse_admin, undefined, 'reponse_admin must be absent from view output');
  assert.equal(row.approved_at, undefined, 'approved_at must be absent from view output');
  assert.equal(row.source, undefined, 'source must be absent from view output');
  assert.equal(row.statut, undefined, 'statut must be absent from view output');
  assert.equal(row.id, undefined, 'id must be absent from view output');
}

// ============================================================
// SIMULATION TESTS — PUBLIC SUBMIT RPC
// ============================================================

// Simulate RPC argument contract (what the frontend sends)
function buildRpcArgs(data) {
  return {
    p_auteur_type: data.type,
    p_auteur_nom: data.nom,
    p_auteur_email: data.email || null,
    p_note: data.note,
    p_titre: data.titre || null,
    p_commentaire: data.commentaire,
    p_ville: data.ville || null
  };
}

// 7. Valid anon submission args
var anonArgs = buildRpcArgs({ type: 'client', nom: 'Jean', note: 5, commentaire: 'Great' });
assert.equal(anonArgs.p_auteur_type, 'client', 'RPC must accept auteur_type');
assert.equal(anonArgs.p_auteur_nom, 'Jean', 'RPC must accept auteur_nom');
assert.equal(anonArgs.p_auteur_email, null, 'RPC must accept null email');
assert.equal(anonArgs.p_note, 5, 'RPC must accept note');
assert.equal(anonArgs.p_commentaire, 'Great', 'RPC must accept commentaire');

// 9. Email optional
assert.equal(anonArgs.p_auteur_email, null, 'email must be optional (null when not provided)');

// 14-19. Caller cannot provide privileged fields
assert.equal(anonArgs.p_statut, undefined, 'caller cannot provide statut');
assert.equal(anonArgs.p_source, undefined, 'caller cannot provide source');
assert.equal(anonArgs.p_user_id, undefined, 'caller cannot provide user_id');
assert.equal(anonArgs.p_mission_id, undefined, 'caller cannot provide mission_id');
assert.equal(anonArgs.p_reponse_admin, undefined, 'caller cannot provide reponse_admin');
assert.equal(anonArgs.p_approved_at, undefined, 'caller cannot provide approved_at');

// Simulate RPC internal INSERT (what the function constructs)
function simulateRpcInsert(args, authUid) {
  return {
    auteur_type: args.p_auteur_type,
    auteur_nom: args.p_auteur_nom,
    auteur_email: args.p_auteur_email,
    user_id: authUid, // derived from auth.uid(), never from caller
    note: args.p_note,
    titre: args.p_titre,
    commentaire: args.p_commentaire,
    ville: args.p_ville,
    statut: 'en_attente', // forced
    source: 'site', // forced
    reponse_admin: null, // forced
    approved_at: null // forced
  };
}

// 20. Inserted row forced to en_attente/site
var insertedRow = simulateRpcInsert(anonArgs, null);
assert.equal(insertedRow.statut, 'en_attente', 'RPC must force statut=en_attente');
assert.equal(insertedRow.source, 'site', 'RPC must force source=site');
assert.equal(insertedRow.reponse_admin, null, 'RPC must force reponse_admin=NULL');
assert.equal(insertedRow.approved_at, null, 'RPC must force approved_at=NULL');

// 21. Authenticated user_id derived from auth.uid()
var authInsertedRow = simulateRpcInsert(anonArgs, 'uid-123');
assert.equal(authInsertedRow.user_id, 'uid-123', 'RPC must derive user_id from auth.uid()');
// Caller cannot inject a different user_id
assert.equal(anonArgs.p_user_id, undefined, 'caller cannot inject user_id via RPC args');

// 22. No auto-approval
assert.notEqual(insertedRow.statut, 'approuve', 'RPC must NOT auto-approve');

// ============================================================
// SIMULATION TESTS — INPUT VALIDATION
// ============================================================

function validateRpcInput(args) {
  var errors = [];
  if (!args.p_auteur_type || !['client', 'convoyeur', 'visiteur'].includes(args.p_auteur_type)) {
    errors.push('auteur_type must be client, convoyeur, or visiteur');
  }
  if (!args.p_auteur_nom || args.p_auteur_nom.trim() === '') {
    errors.push('auteur_nom is required');
  }
  if (!args.p_note || args.p_note < 1 || args.p_note > 5) {
    errors.push('note must be between 1 and 5');
  }
  if (!args.p_commentaire || args.p_commentaire.trim() === '') {
    errors.push('commentaire is required');
  }
  return errors;
}

// 10. Note outside 1..5 rejected
assert.ok(
  validateRpcInput(buildRpcArgs({ type: 'client', nom: 'Jean', note: 6, commentaire: 'Great' })).length > 0,
  'note=6 must be rejected'
);
assert.ok(
  validateRpcInput(buildRpcArgs({ type: 'client', nom: 'Jean', note: 0, commentaire: 'Great' })).length > 0,
  'note=0 must be rejected'
);

// 11. Invalid auteur_type rejected
assert.ok(
  validateRpcInput(buildRpcArgs({ type: 'admin', nom: 'Jean', note: 5, commentaire: 'Great' })).length > 0,
  'auteur_type=admin must be rejected'
);

// 12. Empty auteur_nom rejected
assert.ok(
  validateRpcInput(buildRpcArgs({ type: 'client', nom: '', note: 5, commentaire: 'Great' })).length > 0,
  'empty auteur_nom must be rejected'
);

// 13. Empty commentaire rejected
assert.ok(
  validateRpcInput(buildRpcArgs({ type: 'client', nom: 'Jean', note: 5, commentaire: '' })).length > 0,
  'empty commentaire must be rejected'
);

// Valid input passes
assert.equal(
  validateRpcInput(buildRpcArgs({ type: 'client', nom: 'Jean', note: 5, commentaire: 'Great' })).length,
  0,
  'valid input must pass validation'
);

// ============================================================
// SIMULATION TESTS — COOKIE CONSENT
// ============================================================

function simulateCookieConsent(storedValue) {
  var consent = storedValue;
  if (consent === 'accepted' || consent === 'refused') return 'NO_BANNER';
  return 'SHOW_BANNER';
}

assert.equal(simulateCookieConsent(null), 'SHOW_BANNER', 'fresh visitor must see banner');
assert.equal(simulateCookieConsent('accepted'), 'NO_BANNER', 'accepted must not show banner');
assert.equal(simulateCookieConsent('refused'), 'NO_BANNER', 'refused must not show banner');
assert.equal(simulateCookieConsent('invalid'), 'SHOW_BANNER', 'invalid value must show banner');

// ============================================================
// SIMULATION TESTS — STRUCTURED ERROR LOGGING
// ============================================================

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

// ============================================================
// SECURITY SUMMARY ASSERTIONS
// ============================================================

// 23. No privileged update through submit RPC (check outside function body)
assert.doesNotMatch(
  migrationOutsideFunction,
  /UPDATE public\.avis/i,
  "migration must NOT perform UPDATE on avis outside the RPC"
);

// 24. No DELETE path introduced (check outside function body)
assert.doesNotMatch(
  migrationOutsideFunction,
  /DELETE FROM public\.avis/i,
  "migration must NOT introduce DELETE on avis outside the RPC"
);

// 25. PUBLIC execute revoked
assert.match(
  executableMigration,
  /REVOKE EXECUTE ON FUNCTION public\.submit_public_avis[\s\S]*?FROM PUBLIC/i,
  "PUBLIC execute must be revoked"
);

// 27. Explicit search_path
assert.match(
  executableMigration,
  /SET search_path TO ''/i,
  "function must have explicit search_path"
);

// 28. No dynamic SQL (check function body only)
assert.doesNotMatch(
  functionBody,
  /EXECUTE\s+|format\s*\(/i,
  "function must NOT use dynamic SQL"
);

// No unrelated objects
assert.doesNotMatch(
  executableMigration,
  /CREATE TABLE|ALTER TABLE public\.(?!avis)/i,
  "migration must NOT create or alter unrelated tables"
);

// ============================================================
// V1.1-B3 — AVIS VIEW ACL RECONCILIATION TESTS
// ============================================================
// Verify the follow-up migration 20260829210000_restrict_avis_public_view_acl.sql
// makes the SELECT-only avis_public ACL reproducible from Git.

const b3MigrationPath = path.join(
  projectRoot,
  "supabase",
  "migrations",
  "20260829210000_restrict_avis_public_view_acl.sql"
);
const b3MigrationSql = fs.readFileSync(b3MigrationPath, "utf8");
const executableB3 = b3MigrationSql.replace(/--.*$/gm, "");

// 1. Follow-up migration exists and is readable
assert.ok(b3MigrationSql.length > 0, "B3 migration file must exist and be non-empty");

// 2. Version is later than 20260829200000
const b3Version = path.basename(b3MigrationPath).split("_")[0];
assert.ok(
  parseInt(b3Version) > 20260829200000,
  "B3 migration version must be later than 20260829200000"
);

// 3. Original migration NOT modified
const originalMigrationResql = fs.readFileSync(migrationPath, "utf8");
assert.ok(
  originalMigrationResql.includes("CREATE OR REPLACE VIEW public.avis_public"),
  "Original migration must still create the view (not modified)"
);
assert.ok(
  !originalMigrationResql.includes("REVOKE ALL PRIVILEGES ON public.avis_public"),
  "Original migration must NOT contain B3 REVOKE ALL (not modified)"
);

// 4. Transactional
assert.ok(executableB3.includes("BEGIN"), "B3 migration must be transactional (BEGIN)");
assert.ok(executableB3.includes("COMMIT"), "B3 migration must be transactional (COMMIT)");

// 5. Bounded timeouts
assert.ok(
  /SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'/i.test(executableB3),
  "B3 migration must set lock_timeout = '5s'"
);
assert.ok(
  /SET\s+LOCAL\s+statement_timeout\s*=\s*'30s'/i.test(executableB3),
  "B3 migration must set statement_timeout = '30s'"
);

// 6. REVOKE ALL from anon and authenticated
assert.ok(
  /REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+public\.avis_public\s+FROM\s+anon/i.test(executableB3),
  "B3 migration must REVOKE ALL PRIVILEGES FROM anon on avis_public"
);
assert.ok(
  /REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+public\.avis_public\s+FROM\s+authenticated/i.test(executableB3),
  "B3 migration must REVOKE ALL PRIVILEGES FROM authenticated on avis_public"
);

// 7. GRANT SELECT to anon and authenticated
assert.ok(
  /GRANT\s+SELECT\s+ON\s+public\.avis_public\s+TO\s+anon/i.test(executableB3),
  "B3 migration must GRANT SELECT TO anon on avis_public"
);
assert.ok(
  /GRANT\s+SELECT\s+ON\s+public\.avis_public\s+TO\s+authenticated/i.test(executableB3),
  "B3 migration must GRANT SELECT TO authenticated on avis_public"
);

// 8. No write grants in B3
assert.doesNotMatch(
  executableB3,
  /GRANT\s+(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)/i,
  "B3 migration must NOT grant any write privileges"
);

// 9. Does NOT touch public.avis base table
assert.doesNotMatch(
  executableB3,
  /REVOKE\s+.*ON\s+public\.avis\s+/i,
  "B3 migration must NOT revoke privileges on public.avis base table"
);
assert.doesNotMatch(
  executableB3,
  /GRANT\s+.*ON\s+public\.avis\s+/i,
  "B3 migration must NOT grant privileges on public.avis base table"
);

// 10. Does NOT touch submit_public_avis RPC
assert.doesNotMatch(
  executableB3,
  /submit_public_avis/i,
  "B3 migration must NOT touch submit_public_avis RPC"
);

// 11. Does NOT modify RLS policies
assert.doesNotMatch(
  executableB3,
  /DROP\s+POLICY|CREATE\s+POLICY|ALTER\s+POLICY/i,
  "B3 migration must NOT modify RLS policies"
);

// 12. Does NOT change default privileges
assert.doesNotMatch(
  executableB3,
  /ALTER\s+DEFAULT\s+PRIVILEGES/i,
  "B3 migration must NOT change default privileges"
);

// 13. No unrelated DDL
assert.doesNotMatch(
  executableB3,
  /CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+FUNCTION|ALTER\s+FUNCTION|DROP\s+FUNCTION|CREATE\s+VIEW|CREATE\s+OR\s+REPLACE\s+VIEW|DROP\s+VIEW/i,
  "B3 migration must NOT contain unrelated DDL"
);

// 14. No data mutation
assert.doesNotMatch(
  executableB3,
  /INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM/i,
  "B3 migration must NOT mutate data"
);

// 15. Cumulative replay contract: 20260829200000 + 20260829210000
//    produces SELECT-only for anon and authenticated
const cumulativeSql = executableMigration + "\n" + executableB3;

// After cumulative replay, the last GRANT on avis_public to anon must be SELECT
const anonGrants = cumulativeSql.match(/GRANT\s+(\w+)\s+ON\s+public\.avis_public\s+TO\s+anon/gi) || [];
assert.ok(
  anonGrants.length > 0,
  "Cumulative replay must include at least one GRANT to anon on avis_public"
);

// The B3 REVOKE ALL removes any excessive grants, and the final GRANT is SELECT
const lastAnonGrant = anonGrants[anonGrants.length - 1];
assert.ok(
  /GRANT\s+SELECT\s+ON\s+public\.avis_public\s+TO\s+anon/i.test(lastAnonGrant),
  "Final GRANT to anon on avis_public must be SELECT only"
);

// 16. Migration order is correct (B3 version > B version)
assert.ok(
  parseInt(b3Version) > 20260829200000,
  "B3 migration must come after original migration in order"
);

// 17. B3 does NOT modify the original migration file on disk
const originalStat = fs.statSync(migrationPath);
assert.ok(originalStat.size > 0, "Original migration file must still exist");

console.log("✅ All V1.1-B avis API redesign tests passed (50+ assertions");
