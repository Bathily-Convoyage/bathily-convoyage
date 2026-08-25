import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../supabase/migrations/20260825124542_performance_indexes_p4_1a.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');
const normalized = sql.replace(/\s+/g, ' ').trim();

const foreignKeyIndexes = [
  ['idx_convoyeur_candidatures_existing_auth_user_id', 'convoyeur_candidatures', 'existing_auth_user_id'],
  ['idx_edls_supersedes_edl_id', 'edls', 'supersedes_edl_id'],
  ['idx_mission_events_mission_id', 'mission_events', 'mission_id'],
  ['idx_mission_tracking_tokens_mission_id', 'mission_tracking_tokens', 'mission_id'],
  ['idx_notification_outbox_mission_id', 'notification_outbox', 'mission_id'],
];

const outboxIndexes = [
  [
    'notification_outbox_pending_created_at_idx',
    /ON public\.notification_outbox \(created_at\) WHERE status = 'pending';/i,
  ],
  [
    'notification_outbox_retry_ready_idx',
    /ON public\.notification_outbox \(next_retry_at, created_at\) WHERE status = 'retry';/i,
  ],
  [
    'notification_outbox_prepared_ready_idx',
    /ON public\.notification_outbox \(prepared_at, created_at\) WHERE status = 'prepared';/i,
  ],
  [
    'notification_outbox_sending_lease_idx',
    /ON public\.notification_outbox \(current_attempt_started_at\) WHERE status = 'sending' AND current_attempt_started_at IS NOT NULL;/i,
  ],
  [
    'notification_outbox_provider_deadline_idx',
    /ON public\.notification_outbox \(first_provider_attempt_at\) WHERE status IN \('retry', 'prepared', 'sending'\) AND first_provider_attempt_at IS NOT NULL;/i,
  ],
];

assert.match(normalized, /^BEGIN;[\s\S]*COMMIT;$/i, 'migration must be atomic');
assert.match(normalized, /SET LOCAL lock_timeout = '5s';/i, 'migration must fail fast on lock contention');
assert.match(normalized, /SET LOCAL statement_timeout = '2min';/i, 'migration must cap execution time');

for (const [indexName, tableName, columnName] of foreignKeyIndexes) {
  const pattern = new RegExp(
    `CREATE INDEX IF NOT EXISTS ${indexName} ON public\\.${tableName} \\(${columnName}\\);`,
    'i',
  );
  assert.match(normalized, pattern, `${tableName}.${columnName} must have a covering index`);
  console.log(`ok - ${tableName}.${columnName} foreign key is covered`);
}

for (const [indexName, definition] of outboxIndexes) {
  assert.match(
    normalized,
    new RegExp(`CREATE INDEX IF NOT EXISTS ${indexName} ${definition.source}`, 'i'),
    `${indexName} must match the worker predicate`,
  );
  console.log(`ok - ${indexName} is a targeted partial index`);
}

const createIndexes = [...normalized.matchAll(/CREATE INDEX IF NOT EXISTS ([a-z0-9_]+) ON public\.([a-z0-9_]+)/gi)];
assert.equal(createIndexes.length, 10, 'migration must create exactly ten indexes');
assert.equal(new Set(createIndexes.map((match) => match[1])).size, 10, 'every index name must be unique');
assert.deepEqual(
  [...new Set(createIndexes.map((match) => match[2]))].sort(),
  ['convoyeur_candidatures', 'edls', 'mission_events', 'mission_tracking_tokens', 'notification_outbox'],
  'migration must touch only the five advisor-reported tables',
);

assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i, 'migration must not mutate application rows');
assert.doesNotMatch(sql, /\b(?:DROP|ALTER TABLE|CREATE TABLE)\b/i, 'migration must not change or remove table objects');
assert.doesNotMatch(sql, /\b(?:POLICY|FUNCTION|TRIGGER|GRANT|REVOKE)\b/i, 'migration must not change RLS or privileges');
assert.doesNotMatch(sql, /\bCONCURRENTLY\b/i, 'transactional migration must not use CONCURRENTLY');

console.log('\n20/20 P4.1a performance index checks passed');
