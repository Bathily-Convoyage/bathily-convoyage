import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const migrationPath = path.join(
  projectRoot,
  "supabase",
  "migrations",
  "20260828073053_consolidate_redundant_rls_p2_1.sql"
);
const sql = fs.readFileSync(migrationPath, "utf8");
const normalized = sql.replace(/\s+/g, " ").trim();

assert.match(normalized, /^BEGIN;[\s\S]*COMMIT;$/i);
assert.match(normalized, /SET LOCAL lock_timeout = '5s';/i);
assert.match(normalized, /SET LOCAL statement_timeout = '2min';/i);

const expectedDrops = [
  ["clients_insert_admin", "clients"],
  ["clients_insert_authenticated", "clients"],
  ["clients_insert_own", "clients"],
  ["clients_select_own", "clients"],
  ["convoyeurs_select_admin", "convoyeurs"],
  ["convoyeurs_select_own", "convoyeurs"],
  ["devis_select_admin_or_own", "devis"],
];

const dropStatements = normalized.match(/DROP POLICY [^;]+;/gi) ?? [];
assert.equal(dropStatements.length, expectedDrops.length, "only the seven proven redundant policies may be dropped");

for (const [policy, table] of expectedDrops) {
  assert.match(
    normalized,
    new RegExp(`DROP POLICY "${policy}" ON public\\.${table};`, "i"),
    `${table}.${policy} must be removed`
  );
}

const createStatements = normalized.match(/CREATE POLICY [\s\S]*?;/gi) ?? [];
assert.equal(createStatements.length, 1, "only the consolidated clients INSERT policy may be created");
assert.match(
  createStatements[0],
  /CREATE POLICY "clients_insert_admin_or_own" ON public\.clients FOR INSERT TO authenticated WITH CHECK/i
);
assert.match(
  createStatements[0],
  /c_admin\.auth_user_id = \(SELECT auth\.uid\(\)\) AND c_admin\.role = 'admin'/i,
  "the legacy admin branch must remain unchanged"
);
assert.match(
  createStatements[0],
  /OR auth_user_id = \(SELECT auth\.uid\(\)\)/i,
  "the own-row branch must remain unchanged"
);

for (const retainedPolicy of [
  "clients_select_own_or_admin",
  "convoyeurs_select_own_or_admin",
  "devis_select_own_or_admin",
]) {
  assert.doesNotMatch(
    normalized,
    new RegExp(`(?:DROP|ALTER) POLICY "${retainedPolicy}"`, "i"),
    `${retainedPolicy} must remain untouched`
  );
}

const executableSql = sql.replace(/--.*$/gm, "");
const authUidCalls = executableSql.match(/auth\.uid\(\)/gi) ?? [];
const wrappedAuthUidCalls = executableSql.match(/\(\s*SELECT\s+auth\.uid\(\)\s*\)/gi) ?? [];
assert.equal(authUidCalls.length, 2, "the consolidated predicate must have exactly two auth.uid calls");
assert.equal(wrappedAuthUidCalls.length, authUidCalls.length, "every auth.uid call must keep the initPlan wrapper");
assert.doesNotMatch(sql, /\b(?:GRANT|REVOKE|ALTER TABLE|INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\b/i);

const bools = [false, true];
for (const legacyAdmin of bools) {
  for (const own of bools) {
    const oldClientsInsert = legacyAdmin || own || own;
    const newClientsInsert = legacyAdmin || own;
    assert.equal(newClientsInsert, oldClientsInsert, "clients INSERT access must be equivalent");
  }
}

for (const isAdmin of bools) {
  for (const own of bools) {
    for (const emailMatch of bools) {
      const oldClientsSelect = own || isAdmin || own || emailMatch;
      const newClientsSelect = isAdmin || own || emailMatch;
      assert.equal(newClientsSelect, oldClientsSelect, "clients SELECT access must be equivalent");
    }
  }
}

for (const canonicalAdmin of bools) {
  for (const legacyAdmin of bools) {
    for (const own of bools) {
      for (const emailMatch of bools) {
        for (const banned of bools) {
          const isAdmin = canonicalAdmin || legacyAdmin;
          const oldConvoyeurSelect =
            (!banned && legacyAdmin) ||
            (!banned && own) ||
            isAdmin ||
            own ||
            emailMatch;
          const newConvoyeurSelect = isAdmin || own || emailMatch;
          assert.equal(newConvoyeurSelect, oldConvoyeurSelect, "convoyeurs SELECT access must be equivalent");
        }
      }
    }
  }
}

const bannedOwnOld = (false && false) || (false && true) || false || true || false;
const bannedOwnNew = false || true || false;
assert.equal(bannedOwnOld, true, "a banned convoyeur could already read their own profile");
assert.equal(bannedOwnNew, bannedOwnOld, "P2.1 must preserve the banned-own-profile behavior");

for (const isAdmin of bools) {
  for (const emailMatch of bools) {
    const oldDevisSelect = isAdmin || emailMatch || isAdmin || emailMatch;
    const newDevisSelect = isAdmin || emailMatch;
    assert.equal(newDevisSelect, oldDevisSelect, "devis SELECT access must be equivalent");
  }
}

console.log("P2.1 RLS consolidation checks passed, including banned convoyeur equivalence.");
