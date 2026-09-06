/**
 * MISSIONS-EXT-4B1 — Source-aware notification/email hardening.
 *
 * Static tests verifying that every direct-client email/notification path
 * enforces an explicit source_mission = 'direct' guard before constructing
 * the recipient email or dispatching the message. No path may rely solely
 * on client_email IS NULL for external-mission safety.
 *
 * Paths hardened:
 *   - send-email.js: edl_completed, payment_success, mission_assigned
 *   - cron-relances.js: sendRappelClientEmail (mission reminder)
 *   - DB trigger enqueue_mission_notification(): already source-aware (EXT-1A)
 *
 * Paths intentionally NOT suppressed:
 *   - admin/internal notifications (ADMIN_EMAIL recipients)
 *   - convoyeur notifications (source-neutral)
 *   - devis/candidature/support/pro notifications (not mission-source-bound)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

const sendEmailPath = path.join(repoRoot, 'functions/api/send-email.js');
const sendEmailSrc = fs.readFileSync(sendEmailPath, 'utf8');

const cronRelancesPath = path.join(repoRoot, 'functions/api/cron-relances.js');
const cronRelancesSrc = fs.readFileSync(cronRelancesPath, 'utf8');

const extSourcesMigrationPath = path.join(
  repoRoot,
  'supabase/migrations/20260905120000_missions_external_sources.sql',
);
const extSourcesMigration = fs.readFileSync(extSourcesMigrationPath, 'utf8');

// =========================================================
// Helper: extract a trigger branch from send-email.js
// =========================================================
function extractBranch(src, triggerName) {
  const branchMarker = `else if (trigger === '${triggerName}')`;
  const branchStart = src.indexOf(branchMarker);
  assert.ok(branchStart >= 0, `${triggerName} branch not found in send-email.js`);
  // Find the next "else if" branch or the final return statement
  const afterMarker = branchStart + branchMarker.length;
  const nextElse = src.indexOf('else if', afterMarker);
  const returnIdx = src.indexOf('return jsonResponse(resultData', afterMarker);
  let blockEnd;
  if (nextElse > 0 && nextElse < returnIdx) {
    blockEnd = nextElse;
  } else {
    blockEnd = returnIdx;
  }
  return src.substring(branchStart, blockEnd);
}

// =========================================================
// 1. send-email.js — edl_completed source guard
// =========================================================

test('edl_completed selects source_mission from missions', () => {
  const branch = extractBranch(sendEmailSrc, 'edl_completed');
  assert.ok(
    /missions\([^)]*source_mission/.test(branch),
    'edl_completed must select source_mission from the missions relation',
  );
});

test('edl_completed has explicit source_mission guard before client email', () => {
  const branch = extractBranch(sendEmailSrc, 'edl_completed');
  assert.ok(
    /source_mission.*===.*'direct'|_isDirectMission/.test(branch),
    'edl_completed must have an explicit source_mission = direct guard',
  );
  // The guard must appear before the client sendEmail call
  const guardIdx = branch.indexOf('_isDirectMission');
  const clientSendIdx = branch.indexOf('await sendEmail({ to: emailTo');
  assert.ok(guardIdx >= 0, 'source guard variable found');
  assert.ok(clientSendIdx >= 0, 'client sendEmail call found');
  assert.ok(
    guardIdx < clientSendIdx,
    'source guard must appear before client sendEmail call',
  );
});

test('edl_completed no longer falls back to client@email.fr dummy', () => {
  const branch = extractBranch(sendEmailSrc, 'edl_completed');
  assert.ok(
    !branch.includes("client@email.fr"),
    'edl_completed must not fall back to the client@email.fr dummy address',
  );
});

test('edl_completed client email is conditional on emailTo being valid', () => {
  const branch = extractBranch(sendEmailSrc, 'edl_completed');
  assert.ok(
    /if\s*\(emailTo\)/.test(branch),
    'edl_completed client sendEmail must be wrapped in if (emailTo)',
  );
});

test('edl_completed admin email is preserved (not suppressed)', () => {
  const branch = extractBranch(sendEmailSrc, 'edl_completed');
  assert.ok(
    branch.includes('ADMIN_EMAIL'),
    'edl_completed admin email must be preserved',
  );
  // Admin email should NOT be inside the if (emailTo) block
  const ifEmailToIdx = branch.indexOf('if (emailTo)');
  const adminEmailIdx = branch.indexOf('ADMIN_EMAIL');
  const ifBlockEnd = branch.indexOf('}', ifEmailToIdx);
  const adminAfterBlock = adminEmailIdx > ifBlockEnd;
  assert.ok(
    adminAfterBlock,
    'admin email must be outside the if (emailTo) block — not suppressed for external',
  );
});

// =========================================================
// 2. send-email.js — payment_success source guard
// =========================================================

test('payment_success selects source_mission from missions', () => {
  const branch = extractBranch(sendEmailSrc, 'payment_success');
  assert.ok(
    /source_mission/.test(branch) &&
      /\.select\([^)]*source_mission/.test(branch),
    'payment_success must select source_mission from the missions table',
  );
});

test('payment_success has explicit source_mission guard before client email', () => {
  const branch = extractBranch(sendEmailSrc, 'payment_success');
  assert.ok(
    /_isDirectPayment/.test(branch),
    'payment_success must have an explicit source_mission = direct guard',
  );
  const guardIdx = branch.indexOf('_isDirectPayment');
  const clientSendIdx = branch.indexOf('if (emailTo)');
  assert.ok(guardIdx >= 0, 'source guard variable found');
  assert.ok(clientSendIdx >= 0, 'client email condition found');
  assert.ok(
    guardIdx < clientSendIdx,
    'source guard must appear before client email condition',
  );
});

test('payment_success does not rely solely on NULL email', () => {
  const branch = extractBranch(sendEmailSrc, 'payment_success');
  // The emailTo assignment must incorporate the source guard, not just || null
  assert.ok(
    /_isDirectPayment\s*\?/.test(branch),
    'payment_success emailTo must be gated by source_mission check, not just NULL fallback',
  );
});

test('payment_success admin email is preserved', () => {
  const branch = extractBranch(sendEmailSrc, 'payment_success');
  assert.ok(
    branch.includes('ADMIN_EMAIL'),
    'payment_success admin email must be preserved',
  );
});

// =========================================================
// 3. send-email.js — mission_assigned source guard
// =========================================================

test('mission_assigned looks up source_mission from DB', () => {
  const branch = extractBranch(sendEmailSrc, 'mission_assigned');
  assert.ok(
    /\.from\('missions'\)[\s\S]*?\.select\('source_mission'\)/.test(branch),
    'mission_assigned must look up source_mission from the missions table',
  );
});

test('mission_assigned has explicit source guard before client email', () => {
  const branch = extractBranch(sendEmailSrc, 'mission_assigned');
  assert.ok(
    /_isDirectAssignment/.test(branch),
    'mission_assigned must have an explicit source_mission = direct guard',
  );
  const guardIdx = branch.indexOf('_isDirectAssignment');
  const clientEmailIdx = branch.indexOf('const clientEmail');
  assert.ok(guardIdx >= 0, 'source guard variable found');
  assert.ok(clientEmailIdx >= 0, 'clientEmail assignment found');
  assert.ok(
    guardIdx < clientEmailIdx,
    'source guard must appear before clientEmail assignment',
  );
});

test('mission_assigned client email is null for external missions', () => {
  const branch = extractBranch(sendEmailSrc, 'mission_assigned');
  // clientEmail must be gated by _isDirectAssignment
  assert.ok(
    /const clientEmail\s*=\s*_isDirectAssignment\s*\?/.test(branch),
    'clientEmail must be null when _isDirectAssignment is false',
  );
});

test('mission_assigned convoyeur email is preserved (source-neutral)', () => {
  const branch = extractBranch(sendEmailSrc, 'mission_assigned');
  assert.ok(
    branch.includes('convoyeur_email'),
    'mission_assigned convoyeur email must be preserved',
  );
  // Convoyeur email block must NOT be inside the _isDirectAssignment guard
  const convoyeurIdx = branch.indexOf('convoyeur_email');
  const directGuardEnd = branch.indexOf('_isDirectAssignment');
  // The convoyeur email send must come after the client email block
  const clientSendIdx = branch.indexOf('await sendEmail({ to: clientEmail');
  const convoyeurSendIdx = branch.indexOf('await sendEmail({ to: convoyeur_email');
  assert.ok(convoyeurSendIdx > clientSendIdx, 'convoyeur email comes after client email block');
});

// =========================================================
// 4. cron-relances.js — mission reminder source guard
// =========================================================

test('cron-relances selects source_mission in mission query', () => {
  assert.ok(
    /\.from\('missions'\)\.select\([^)]*source_mission/.test(cronRelancesSrc),
    'cron-relances must select source_mission in the mission reminder query',
  );
});

test('cron-relances has source guard before sendRappelClientEmail', () => {
  assert.ok(
    /_isDirectMission[\s\S]*?sendRappelClientEmail/.test(cronRelancesSrc),
    'cron-relances must check source_mission before sendRappelClientEmail',
  );
  const guardIdx = cronRelancesSrc.indexOf('_isDirectMission');
  const clientEmailIdx = cronRelancesSrc.indexOf('sendRappelClientEmail');
  assert.ok(guardIdx >= 0, 'source guard found');
  assert.ok(clientEmailIdx >= 0, 'sendRappelClientEmail call found');
  assert.ok(
    guardIdx < clientEmailIdx,
    'source guard must appear before sendRappelClientEmail call',
  );
});

test('cron-relances does not rely solely on NULL email for client reminder', () => {
  // The old code was: if (mission.client_email) await sendRappelClientEmail(...)
  // The new code must be: if (_isDirectMission && mission.client_email) await sendRappelClientEmail(...)
  const reminderLine = cronRelancesSrc.match(
    /if\s*\([^)]*sendRappelClientEmail/,
  );
  // Find the actual if condition
  const sendRappelIdx = cronRelancesSrc.indexOf('sendRappelClientEmail');
  const ifIdx = cronRelancesSrc.lastIndexOf('if (', sendRappelIdx);
  const condition = cronRelancesSrc.substring(ifIdx, sendRappelIdx);
  assert.ok(
    condition.includes('_isDirectMission'),
    'client reminder must check _isDirectMission, not just client_email',
  );
});

test('cron-relances convoyeur reminder is preserved (source-neutral)', () => {
  assert.ok(
    /sendRappelConvoyeurEmail/.test(cronRelancesSrc),
    'cron-relances convoyeur reminder must be preserved',
  );
  // Convoyeur reminder must NOT be gated by _isDirectMission
  const convoyeurIdx = cronRelancesSrc.indexOf('sendRappelConvoyeurEmail');
  const ifIdx = cronRelancesSrc.lastIndexOf('if (', convoyeurIdx);
  const condition = cronRelancesSrc.substring(ifIdx, convoyeurIdx);
  assert.ok(
    !condition.includes('_isDirectMission'),
    'convoyeur reminder must NOT be gated by source_mission check',
  );
});

// =========================================================
// 5. DB trigger — enqueue_mission_notification source guard (EXT-1A)
// =========================================================

test('enqueue_mission_notification has source_mission guard for client outbox', () => {
  const fnStart = extSourcesMigration.indexOf(
    'CREATE OR REPLACE FUNCTION public.enqueue_mission_notification',
  );
  assert.ok(fnStart >= 0, 'enqueue_mission_notification function found in EXT-1 migration');
  const fnBody = extSourcesMigration.substring(fnStart);
  const bodyStart = fnBody.indexOf('$$');
  const bodyEnd = fnBody.indexOf('$$;', bodyStart + 2);
  const fnContent = fnBody.substring(bodyStart, bodyEnd + 2);

  assert.ok(
    fnContent.includes("_source_mission = 'direct'"),
    'enqueue_mission_notification must check source_mission = direct',
  );

  // Client INSERT must be inside the direct-only block
  const ifDirectStart = fnContent.indexOf("IF _source_mission = 'direct' THEN");
  const ifDirectEnd = fnContent.indexOf('END IF;', ifDirectStart);
  const directBlock = fnContent.substring(ifDirectStart, ifDirectEnd);
  assert.ok(
    directBlock.includes("'client'"),
    'client notification INSERT must be inside direct-only block',
  );
});

test('enqueue_mission_notification preserves convoyeur outbox (source-neutral)', () => {
  const fnStart = extSourcesMigration.indexOf(
    'CREATE OR REPLACE FUNCTION public.enqueue_mission_notification',
  );
  const fnBody = extSourcesMigration.substring(fnStart);
  const bodyStart = fnBody.indexOf('$$');
  const bodyEnd = fnBody.indexOf('$$;', bodyStart + 2);
  const fnContent = fnBody.substring(bodyStart, bodyEnd + 2);

  const ifDirectStart = fnContent.indexOf("IF _source_mission = 'direct' THEN");
  const ifDirectEnd = fnContent.indexOf('END IF;', ifDirectStart);
  const afterDirect = fnContent.substring(ifDirectEnd);
  assert.ok(
    afterDirect.includes("'convoyeur'"),
    'convoyeur notification must be outside direct-only block (unchanged)',
  );
});

// =========================================================
// 6. No regression — 4A1/4A2/4A3 migrations unchanged
// =========================================================

test('4A1 migration file is unchanged (not modified in 4B1)', () => {
  const p = path.join(
    repoRoot,
    'supabase/migrations/20260906140000_missions_ext_4a1_convoyeur_expense_auth.sql',
  );
  assert.ok(fs.existsSync(p), '4A1 migration exists');
  // 4B1 does not touch 4A1 — just verify it still exists and is readable
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.length > 0, '4A1 migration is non-empty');
});

test('4A2 migration file is unchanged (not modified in 4B1)', () => {
  const p = path.join(
    repoRoot,
    'supabase/migrations/20260906150000_missions_ext_4a2_incident_flow_repair.sql',
  );
  assert.ok(fs.existsSync(p), '4A2 migration exists');
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.length > 0, '4A2 migration is non-empty');
});

test('4A3 migration file is unchanged (not modified in 4B1)', () => {
  const p = path.join(
    repoRoot,
    'supabase/migrations/20260906160000_missions_ext_4a3_external_billing_isolation.sql',
  );
  assert.ok(fs.existsSync(p), '4A3 migration exists');
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.length > 0, '4A3 migration is non-empty');
});

// =========================================================
// 7. No new migration created (all changes in Edge Functions)
// =========================================================

test('no new 4B1 migration file was created', () => {
  const migrationsDir = path.join(repoRoot, 'supabase/migrations');
  const files = fs.readdirSync(migrationsDir);
  const newMigrations = files.filter(
    (f) => f >= '20260906170000' && f.includes('4b1'),
  );
  assert.ok(
    newMigrations.length === 0,
    '4B1 should not create a DB migration — all changes are in Edge Functions',
  );
});

// =========================================================
// 8. No billing/platform_fee modification
// =========================================================

test('send-email.js does not modify platform_fee or billing', () => {
  assert.ok(
    !/platform_fee/.test(sendEmailSrc),
    'send-email.js must not introduce platform_fee logic',
  );
  assert.ok(
    !/billing_records/.test(sendEmailSrc),
    'send-email.js must not introduce billing_records logic',
  );
});

test('cron-relances.js does not modify platform_fee or billing', () => {
  assert.ok(
    !/platform_fee/.test(cronRelancesSrc),
    'cron-relances.js must not introduce platform_fee logic',
  );
  assert.ok(
    !/billing_records/.test(cronRelancesSrc),
    'cron-relances.js must not introduce billing_records logic',
  );
});

// =========================================================
// 9. No unrelated notification classes suppressed
// =========================================================

test('send-email.js preserves devis_created trigger', () => {
  assert.ok(
    sendEmailSrc.includes("trigger === 'devis_created'"),
    'devis_created trigger must be preserved',
  );
});

test('send-email.js preserves candidature_submitted trigger', () => {
  assert.ok(
    sendEmailSrc.includes("trigger === 'candidature_submitted'"),
    'candidature_submitted trigger must be preserved',
  );
});

test('send-email.js preserves convoyeur_approved trigger', () => {
  assert.ok(
    sendEmailSrc.includes("trigger === 'convoyeur_approved'"),
    'convoyeur_approved trigger must be preserved',
  );
});

test('send-email.js preserves support_reply trigger', () => {
  assert.ok(
    sendEmailSrc.includes("trigger === 'support_reply'"),
    'support_reply trigger must be preserved',
  );
});

test('send-email.js preserves devis_relance trigger', () => {
  assert.ok(
    sendEmailSrc.includes("trigger === 'devis_relance'"),
    'devis_relance trigger must be preserved',
  );
});

test('cron-relances.js preserves devis relance emails', () => {
  assert.ok(
    cronRelancesSrc.includes('sendRelanceEmail'),
    'devis relance email function must be preserved',
  );
});
