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
  "20260825142531_optimize_rls_auth_initplan_p4_1b.sql"
);
const sql = fs.readFileSync(migrationPath, "utf8");

const expectedPolicies = [
  "avis.avis_insert_auth_safe",
  "avis.avis_update_own",
  "candidatures.candidatures_select_own_or_admin_b1",
  "clients.clients_delete_admin",
  "clients.clients_delete_admin_rpc",
  "clients.clients_insert_admin",
  "clients.clients_insert_authenticated",
  "clients.clients_insert_own",
  "clients.clients_select_own",
  "clients.clients_select_own_or_admin",
  "clients.clients_update_own_strict",
  "convoyeur_badges.conv_badges_select_own",
  "convoyeur_candidatures.candidatures_conv_select_own",
  "convoyeurs.convoyeurs_delete_admin",
  "convoyeurs.convoyeurs_delete_admin_rpc",
  "convoyeurs.convoyeurs_insert_admin",
  "convoyeurs.convoyeurs_insert_own",
  "convoyeurs.convoyeurs_select_admin",
  "convoyeurs.convoyeurs_select_own",
  "convoyeurs.convoyeurs_select_own_or_admin",
  "convoyeurs.convoyeurs_update_own",
  "devis.devis_select_admin_or_own",
  "devis.devis_select_own_or_admin",
  "edls.edls_select_client_b2",
  "mission_events.mission_events_client_select_b2",
  "mission_events.mission_events_convoyeur_select_b2",
  "mission_evidence.mission_evidence_select_client_b2",
  "mission_expense_receipts.mission_expense_receipts_select_operator_assigned",
  "mission_expenses.mission_expenses_select_operator_assigned",
  "mission_gps_positions.gps_positions_insert_b3",
  "mission_gps_positions.gps_positions_select_b3",
  "mission_incident_evidence.mission_incident_evidence_select_operator_assigned",
  "mission_incidents.mission_incidents_select_operator_assigned",
  "mission_tracking_tokens.tracking_tokens_insert_b3",
  "mission_tracking_tokens.tracking_tokens_select_b3",
  "missions.missions_select_b3",
  "newsletter_subscribers.newsletter_update_own",
  "parrainages.parrainages_insert_own",
  "parrainages.parrainages_select_own",
  "parrainages.parrainages_update_own",
  "points_fidelite.points_insert_own",
  "points_fidelite.points_select_own",
  "push_subscriptions.push_delete_own",
  "push_subscriptions.push_insert_own",
  "push_subscriptions.push_select_own",
  "reseau_comments.reseau_comments_delete_admin",
  "reseau_comments.reseau_comments_insert_admin_or_convoyeur",
  "reseau_comments.reseau_comments_select_admin_or_convoyeur",
  "reseau_posts.reseau_posts_delete_admin",
  "reseau_posts.reseau_posts_insert_admin_or_convoyeur",
  "reseau_posts.reseau_posts_select_admin_or_convoyeur",
  "support_tickets.support_tickets_delete_concerned",
  "support_tickets.support_tickets_insert_concerned",
  "support_tickets.support_tickets_select_concerned",
  "support_tickets.support_tickets_update_concerned",
  "support_tickets.tickets_select_own_or_admin",
  "system_settings.system_settings_delete_admin",
  "system_settings.system_settings_insert_admin",
  "system_settings.system_settings_update_admin",
  "vehicules.vehicules_delete_own",
  "vehicules.vehicules_insert_own",
  "vehicules.vehicules_select_own",
  "vehicules.vehicules_update_own"
];
const expectedUidCalls = 83;
const expectedJwtCalls = 12;

assert.match(sql, /^\s*--[^\n]*P4\.1b/im);
assert.match(sql, /\bBEGIN\s*;/i);
assert.match(sql, /SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'\s*;/i);
assert.match(sql, /SET\s+LOCAL\s+statement_timeout\s*=\s*'2min'\s*;/i);
assert.match(sql, /\bCOMMIT\s*;\s*$/i);

const statements = sql.match(/ALTER\s+POLICY[\s\S]*?;/gi) ?? [];
assert.equal(statements.length, 63, "exactly 63 RLS policies must be optimized");

const actualPolicies = statements.map((statement) => {
  const parsed = statement.match(
    /ALTER\s+POLICY\s+"([^"]+)"\s+ON\s+"public"\."([^"]+)"/i
  );
  assert.ok(parsed, `unparseable ALTER POLICY statement: ${statement.slice(0, 120)}`);
  assert.match(
    statement,
    /\(\s*select\s+auth\.(?:uid|jwt)\(\)\s*\)/i,
    `missing initPlan wrapper for ${parsed[2]}.${parsed[1]}`
  );
  return `${parsed[2]}.${parsed[1]}`;
});

assert.deepEqual(
  [...actualPolicies].sort(),
  [...expectedPolicies].sort(),
  "the migration must target the exact Production advisor policy set"
);
assert.equal(new Set(actualPolicies).size, 63, "each policy must be altered once");

const uidCalls =
  sql.match(/\(\s*select\s+auth\.uid\(\)\s*\)/gi)?.length ?? 0;
const jwtCalls =
  sql.match(/\(\s*select\s+auth\.jwt\(\)\s*\)/gi)?.length ?? 0;
assert.equal(uidCalls, expectedUidCalls, "all auth.uid calls must be wrapped");
assert.equal(jwtCalls, expectedJwtCalls, "all auth.jwt calls must be wrapped");

const withoutOptimizedAuthCalls = sql
  .replace(/\(\s*select\s+auth\.uid\(\)\s*\)/gi, "")
  .replace(/\(\s*select\s+auth\.jwt\(\)\s*\)/gi, "");
assert.doesNotMatch(
  withoutOptimizedAuthCalls,
  /\bauth\.(?:uid|jwt)\(\)/i,
  "no direct Auth helper call may remain"
);

for (const helper of [
  "is_admin",
  "is_operator",
  "is_internal_user",
  "external_convoyeurs_enabled",
]) {
  assert.match(sql, new RegExp(`\\b${helper}\\(\\)`, "i"));
}
assert.doesNotMatch(
  sql,
  /\(\s*select\s+(?:public\.)?(?:is_admin|is_operator|is_internal_user|external_convoyeurs_enabled)\(\)\s*\)/i,
  "business helper functions must keep their existing evaluation semantics"
);

assert.doesNotMatch(sql, /\b(?:CREATE|DROP)\s+POLICY\b/i);
assert.doesNotMatch(sql, /\bALTER\s+TABLE\b/i);
assert.doesNotMatch(sql, /\b(?:GRANT|REVOKE)\b/i);
assert.doesNotMatch(sql, /\bTO\s+(?:anon|authenticated|public|postgres)\b/i);
assert.doesNotMatch(sql, /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);

console.log(
  `P4.1b RLS initPlan migration checks passed: ${statements.length} policies, ${uidCalls} auth.uid calls, ${jwtCalls} auth.jwt calls.`
);
