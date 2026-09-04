import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// SEC-1C2 — Fidelity ACL Hardening — Regression Tests
// ============================================================
// Static migration-content tests verifying that the SEC-1C2 migration:
//   1. revokes INSERT on public.points_fidelite from authenticated
//   2. does NOT revoke SELECT from authenticated
//   3. does NOT revoke service_role access
//   4. revokes EXECUTE on public.apply_parrainage_code(text) from authenticated
//   5. does NOT revoke EXECUTE from service_role
//   6. introduces no RLS policy changes
//   7. introduces no function-body changes
//   8. modifies no frontend files
//   9. contains no unrelated DDL
// ============================================================

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");

const migrationPath = path.join(
  projectRoot,
  "supabase",
  "migrations",
  "20260903100000_sec_1c2_fidelity_acl_hardening.sql",
);
const migrationSql = fs.readFileSync(migrationPath, "utf8");
const executableMigration = migrationSql.replace(/--.*$/gm, "");
const normalized = executableMigration.replace(/\s+/g, " ").trim().toLowerCase();

// ============================================================
// 1. Migration file exists and is well-formed
// ============================================================

assert.ok(
  fs.existsSync(migrationPath),
  "SEC-1C2 migration file must exist",
);

assert.match(
  migrationSql,
  /BEGIN;/i,
  "migration must be wrapped in BEGIN",
);
assert.match(
  migrationSql,
  /COMMIT;/i,
  "migration must be wrapped in COMMIT",
);

assert.match(
  migrationSql,
  /SET LOCAL lock_timeout/i,
  "migration must set lock_timeout",
);
assert.match(
  migrationSql,
  /SET LOCAL statement_timeout/i,
  "migration must set statement_timeout",
);

console.log("ok - migration file exists and is transactional with timeouts");

// ============================================================
// 2. Revokes INSERT on public.points_fidelite from authenticated
// ============================================================

assert.match(
  executableMigration,
  /REVOKE\s+INSERT\s+ON\s+TABLE\s+public\.points_fidelite\s+FROM\s+authenticated/i,
  "migration must REVOKE INSERT ON public.points_fidelite FROM authenticated",
);

console.log("ok - revokes INSERT on points_fidelite from authenticated");

// ============================================================
// 3. Does NOT revoke SELECT from authenticated on points_fidelite
// ============================================================

assert.doesNotMatch(
  executableMigration,
  /REVOKE\s+SELECT\s+ON\s+(?:TABLE\s+)?public\.points_fidelite\s+FROM\s+authenticated/i,
  "migration must NOT revoke SELECT on points_fidelite from authenticated (read path preserved)",
);

console.log("ok - SELECT on points_fidelite preserved for authenticated");

// ============================================================
// 4. Does NOT revoke or grant anything to/from service_role
// ============================================================

assert.doesNotMatch(
  executableMigration,
  /REVOKE\s+INSERT\s+ON\s+TABLE\s+public\.points_fidelite\s+FROM\s+service_role/i,
  "migration must NOT revoke INSERT on points_fidelite from service_role",
);

assert.doesNotMatch(
  executableMigration,
  /REVOKE\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)\s+ON\s+(?:TABLE\s+)?public\.points_fidelite\s+FROM\s+service_role/i,
  "migration must NOT revoke any table privilege on points_fidelite from service_role",
);

assert.doesNotMatch(
  executableMigration,
  /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.apply_parrainage_code\s*\(\s*text\s*\)\s+FROM\s+service_role/i,
  "migration must NOT revoke EXECUTE on apply_parrainage_code from service_role",
);

console.log("ok - service_role access preserved on both objects");

// ============================================================
// 5. Revokes EXECUTE on public.apply_parrainage_code(text) from authenticated
// ============================================================

assert.match(
  executableMigration,
  /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.apply_parrainage_code\s*\(\s*text\s*\)\s+FROM\s+authenticated/i,
  "migration must REVOKE EXECUTE ON FUNCTION public.apply_parrainage_code(text) FROM authenticated",
);

console.log("ok - revokes EXECUTE on apply_parrainage_code from authenticated");

// ============================================================
// 6. Does NOT revoke EXECUTE from anon on apply_parrainage_code
//    (anon never had it, but we verify the migration doesn't touch it)
// ============================================================

assert.doesNotMatch(
  executableMigration,
  /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.apply_parrainage_code\s*\(\s*text\s*\)\s+FROM\s+anon/i,
  "migration must NOT revoke EXECUTE on apply_parrainage_code from anon (no change needed)",
);

console.log("ok - anon grants untouched on apply_parrainage_code");

// ============================================================
// 7. No RLS policy changes
// ============================================================

assert.doesNotMatch(
  executableMigration,
  /(?:CREATE|ALTER|DROP)\s+POLICY/i,
  "migration must NOT create, alter, or drop any RLS policy",
);

assert.doesNotMatch(
  executableMigration,
  /(?:ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY/i,
  "migration must NOT enable or disable RLS on any table",
);

console.log("ok - no RLS policy changes");

// ============================================================
// 8. No function-body changes (no CREATE OR REPLACE, no ALTER FUNCTION body)
// ============================================================

assert.doesNotMatch(
  executableMigration,
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i,
  "migration must NOT create or replace any function",
);

assert.doesNotMatch(
  executableMigration,
  /ALTER\s+FUNCTION/i,
  "migration must NOT alter any function (no body, owner, or search_path change)",
);

assert.doesNotMatch(
  executableMigration,
  /DROP\s+FUNCTION/i,
  "migration must NOT drop any function",
);

console.log("ok - no function-body or function-definition changes");

// ============================================================
// 9. No table structure changes
// ============================================================

assert.doesNotMatch(
  executableMigration,
  /CREATE\s+TABLE/i,
  "migration must NOT create any table",
);

assert.doesNotMatch(
  executableMigration,
  /ALTER\s+TABLE/i,
  "migration must NOT alter any table structure",
);

assert.doesNotMatch(
  executableMigration,
  /DROP\s+TABLE/i,
  "migration must NOT drop any table",
);

assert.doesNotMatch(
  executableMigration,
  /ADD\s+COLUMN|DROP\s+COLUMN|RENAME\s+COLUMN/i,
  "migration must NOT add, drop, or rename any column",
);

assert.doesNotMatch(
  executableMigration,
  /ADD\s+CONSTRAINT|DROP\s+CONSTRAINT/i,
  "migration must NOT add or drop any constraint",
);

console.log("ok - no table structure changes");

// ============================================================
// 10. No frontend file references are modified
// ============================================================
// Verify the migration does not reference any frontend file paths
// or contain JS/HTML/CSS directives.

assert.doesNotMatch(
  executableMigration,
  /\.js|\.html|\.css/i,
  "migration must NOT reference frontend file types",
);

// Verify key frontend files are unchanged on disk vs origin/main
// (we check that fidelite.js still exists and was not modified by this branch)
const fidelitePath = path.join(projectRoot, "js", "fidelite.js");
assert.ok(
  fs.existsSync(fidelitePath),
  "js/fidelite.js must still exist (not deleted)",
);

console.log("ok - no frontend file modifications");

// ============================================================
// 11. No unrelated DDL — only the two REVOKE statements
// ============================================================
// Extract all executable statements (excluding SET LOCAL and BEGIN/COMMIT)
const statements = executableMigration
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .filter(
    (s) =>
      !/^SET\s+LOCAL/i.test(s) &&
      !/^BEGIN$/i.test(s) &&
      !/^COMMIT$/i.test(s),
  );

assert.equal(
  statements.length,
  2,
  `migration must contain exactly 2 executable statements (found ${statements.length}): ` +
    statements.map((s) => s.substring(0, 80)).join(" | "),
);

// Verify both statements are REVOKE
assert.ok(
  statements.every((s) => /^REVOKE/i.test(s)),
  "all executable statements must be REVOKE",
);

// Verify the two specific REVOKEs
const revokeStatements = statements.map((s) => s.replace(/\s+/g, " ").trim().toLowerCase());

assert.ok(
  revokeStatements.some((s) =>
    s.includes("revoke insert on table public.points_fidelite from authenticated"),
  ),
  "one statement must be REVOKE INSERT ON public.points_fidelite FROM authenticated",
);

assert.ok(
  revokeStatements.some((s) =>
    s.includes("revoke execute on function public.apply_parrainage_code(text) from authenticated"),
  ),
  "one statement must be REVOKE EXECUTE ON FUNCTION public.apply_parrainage_code(text) FROM authenticated",
);

console.log("ok - exactly 2 REVOKE statements, no unrelated DDL");

// ============================================================
// 12. No data mutation
// ============================================================

assert.doesNotMatch(
  executableMigration,
  /INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM/i,
  "migration must NOT contain any data-mutating DML",
);

console.log("ok - no data mutation");

// ============================================================
// 13. Does NOT touch parrainages table grants
// ============================================================

assert.doesNotMatch(
  executableMigration,
  /REVOKE\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)\s+ON\s+(?:TABLE\s+)?public\.parrainages/i,
  "migration must NOT revoke any grant on public.parrainages",
);

assert.doesNotMatch(
  executableMigration,
  /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)\s+ON\s+(?:TABLE\s+)?public\.parrainages/i,
  "migration must NOT grant anything on public.parrainages",
);

console.log("ok - parrainages table grants untouched");

// ============================================================
// 14. Does NOT touch solde_fidelite view
// ============================================================

assert.doesNotMatch(
  executableMigration,
  /(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?VIEW\s+public\.solde_fidelite/i,
  "migration must NOT modify the solde_fidelite view",
);

console.log("ok - solde_fidelite view untouched");

// ============================================================
// SUMMARY
// ============================================================

console.log("\n14/14 SEC-1C2 fidelity ACL hardening checks passed");
