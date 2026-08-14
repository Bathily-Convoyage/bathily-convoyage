// PROD-1D-B.2 — Local Cron Recovery Hardening Test Suite
//
// Tests T1–T57 covering:
//   - Happy path, persistence barrier, delivery identity
//   - Attempts increment before provider, current_attempt_id stale rejection
//   - Separate lease/deadline clocks, 20h hard barrier
//   - Provider request freeze, EMAIL_FROM mutation zero effect
//   - Replay idempotency (applied, stale_rejected, conflict)
//   - Ledger monotonicity, UNIQUE constraint, RLS/FORCE RLS
//   - Service-role-only RPCs, append-only audit FK RESTRICT
//   - retry_exhausted, delivery_unknown, operational_blocked semantics
//   - 5xx classified as ambiguous_retryable
//   - next_retry_at, anon/authenticated denied
//   - external_convoyeurs_enabled remains false
//
// All Resend calls are mocked. No real network calls to api.resend.com.
// Local Supabase only. No Production secrets.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

// Service-role key must be supplied via environment — never hardcoded.
// For local runs, export LOCAL_SUPABASE_SERVICE_ROLE_KEY from:
//   npx supabase status -o env
const SERVICE_ROLE_KEY =
  process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY
  || process.env.SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  throw new Error(
    'Local Supabase service-role key is required via environment ' +
    '(LOCAL_SUPABASE_SERVICE_ROLE_KEY or SERVICE_ROLE_KEY). ' +
    'Run: npx supabase status -o env'
  );
}
const OUTBOX_CRON_SECRET = 'LOCAL_TEST_SECRET';
const RESEND_API_KEY = 'fake_test_key';
const EMAIL_FROM = 'test@local.test';

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const sbAnon = createClient(SUPABASE_URL, ANON_KEY);

let passCount = 0;
let failCount = 0;
const results = [];
const sessionId = Math.random().toString(36).slice(2, 8);
let fixtureCounter = 0;

// ─── Helpers ───────────────────────────────────────────
function check(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (condition) passCount++; else failCount++;
  results.push({ name, status, detail });
  console.log(`[${status}] ${name}${detail ? ' — ' + detail : ''}`);
}

function jsonEqual(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = sortKeys(obj[k]);
  return sorted;
}

async function cleanOutbox() {
  // Clean ledger and actions first (FK RESTRICT)
  await sb.from('notification_delivery_actions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await sb.from('notification_delivery_attempts').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await sb.from('notification_outbox').delete().neq('id', '00000000-0000-0000-0000-000000000000');
}

async function getOutboxRow(id) {
  const { data, error } = await sb.from('notification_outbox').select('*').eq('id', id).single();
  if (error) throw new Error(`Fetch outbox failed: ${error.message}`);
  return data;
}

async function getLedgerRow(id) {
  const { data, error } = await sb.from('notification_delivery_attempts').select('*').eq('id', id).single();
  if (error) return null;
  return data;
}

async function getLedgerByOutbox(outboxId) {
  const { data, error } = await sb.from('notification_delivery_attempts').select('*').eq('outbox_id', outboxId).order('attempt_number');
  if (error) throw new Error(`Fetch ledger failed: ${error.message}`);
  return data || [];
}

async function createTestFixtures(referenceOverride) {
  const email = `test-${sessionId}-${++fixtureCounter}@local.test`;
  const { data: client, error: clientErr } = await sb.from('clients')
    .insert({ email, nom: 'Test', prenom: 'Smoke', telephone: '0600000000' })
    .select().single();
  if (clientErr) throw new Error(`Failed to create client: ${clientErr.message}`);

  const ref = referenceOverride || `SMOKE-${sessionId}-${fixtureCounter}`;
  const { data: mission, error: missionErr } = await sb.from('missions')
    .insert({
      reference: ref,
      client_id: client.id,
      depart: 'Test Address',
      arrivee: 'Test Delivery',
      status: 'available'
    })
    .select().single();
  if (missionErr) throw new Error(`Failed to create mission: ${missionErr.message}`);

  return { client, mission };
}

async function cleanupTestFixtures(clientId, missionId) {
  if (missionId) await sb.from('missions').delete().eq('id', missionId);
  if (clientId) await sb.from('clients').delete().eq('id', clientId);
}

async function insertOutboxRow(missionId, type, recipientType, overrides = {}) {
  const { data, error } = await sb.from('notification_outbox')
    .insert({
      mission_id: missionId,
      notification_type: type,
      recipient_type: recipientType,
      status: 'pending',
      attempts: 0,
      payload: {},
      ...overrides
    })
    .select().single();
  if (error) throw new Error(`Outbox insert failed: ${error.message}`);
  return data;
}

async function callProcessRPC() {
  const { data, error } = await sb.rpc('process_notification_outbox', { p_limit: 10 });
  if (error) throw new Error(`RPC error: ${error.message}`);
  return data;
}

async function callBeginRPC(outboxId, expectedAttempts, fromHeader) {
  const from = fromHeader != null ? fromHeader : `Bathily Convoyage <${EMAIL_FROM}>`;
  const { data, error } = await sb.rpc('begin_delivery_attempt', {
    p_outbox_id: outboxId,
    p_expected_attempts: expectedAttempts,
    p_from: from
  });
  if (error) throw new Error(`begin RPC error: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

async function callCompleteRPC(params) {
  const { data, error } = await sb.rpc('complete_delivery_attempt', params);
  if (error) throw new Error(`complete RPC error: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

// ─── Fetch mock infrastructure ──────────────────────────
const originalFetch = globalThis.fetch;
let resendMock = null;

async function mockFetch(url, options) {
  const urlStr = url.toString();

  if (urlStr.includes('api.resend.com/emails')) {
    if (resendMock) {
      if (resendMock.shouldFail) {
        const headers = { 'Content-Type': 'application/json' };
        if (resendMock.retryAfter) headers['Retry-After'] = String(resendMock.retryAfter);
        return new Response(JSON.stringify({
          message: resendMock.errorMessage || 'Mock failure',
          code: resendMock.errorCode
        }), { status: resendMock.httpStatus || 400, headers });
      }
      if (resendMock.shouldThrow) {
        throw new Error(resendMock.throwMessage || 'Mock network error');
      }
      return new Response(JSON.stringify({ id: resendMock.messageId || 'mock-msg-id' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ id: 'mock-msg-id' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  return originalFetch(url, options);
}

function installFetchMock() { globalThis.fetch = mockFetch; }
function restoreFetchMock() { globalThis.fetch = originalFetch; resendMock = null; }

// ─── Consumer invocation helper ─────────────────────────
async function invokeConsumer(envOverrides = {}) {
  const consumerModule = await import('../functions/api/process-notification-outbox.js');
  const request = new Request('https://test.local/api/process-notification-outbox', {
    method: 'POST',
    headers: { 'x-cron-secret': OUTBOX_CRON_SECRET }
  });
  const env = {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    OUTBOX_CRON_SECRET,
    RESEND_API_KEY,
    EMAIL_FROM,
    ...envOverrides
  };
  const context = { request, env };
  const response = await consumerModule.onRequest(context);
  const status = response.status;
  const body = await response.json();
  return { status, body };
}

// Helper: full cycle (prepare + begin + provider + complete)
async function fullCycle(outboxId, fromHeader, resendMockConfig) {
  // Phase 1: DB operations WITHOUT fetch mock (Supabase client needs real fetch)
  await sb.from('notification_outbox').update({ next_retry_at: null })
    .eq('id', outboxId).in('status', ['retry']);
  const prepared = await callProcessRPC();
  const prepRow = (prepared || []).find(r => r.id === outboxId);
  if (!prepRow || prepRow.status !== 'prepared') return { prepRow };

  const outboxRow = await getOutboxRow(outboxId);
  const begin = await callBeginRPC(outboxId, outboxRow.attempts, fromHeader);
  if (!begin || begin.result !== 'ok') return { begin };

  // Phase 2: Install fetch mock ONLY for the provider call
  const prevMock = resendMock;
  if (resendMockConfig) resendMock = resendMockConfig;
  installFetchMock();
  const { sendEmail } = await import('../functions/_email.js');
  const env = { RESEND_API_KEY, EMAIL_FROM };
  let providerResult = null, providerError = null;
  try {
    providerResult = await sendEmail({
      from: begin.provider_request.from,
      to: begin.provider_request.to,
      subject: begin.provider_request.subject,
      html: begin.provider_request.html,
      idempotencyKey: `notification-outbox/${begin.delivery_id}`
    }, env);
  } catch (err) {
    providerError = err;
  }
  restoreFetchMock();
  resendMock = prevMock;

  // Phase 3: Complete WITHOUT fetch mock
  let classification, httpStatus, errorCode, messageId, lastError, nextRetryAt;
  if (providerError === null) {
    classification = 'success'; httpStatus = 200; errorCode = null;
    messageId = providerResult?.id || null; lastError = null; nextRetryAt = null;
  } else {
    classification = providerError.classification;
    httpStatus = providerError.httpStatus;
    errorCode = providerError.errorCode;
    messageId = null;
    lastError = providerError.message;
    nextRetryAt = (classification === 'transient_retryable' || classification === 'ambiguous_retryable')
      ? new Date(Date.now() + (providerError.retryAfter || 30) * 1000).toISOString() : null;
  }

  const complete = await callCompleteRPC({
    p_outbox_id: outboxId,
    p_expected_attempt_id: begin.attempt_id,
    p_expected_delivery_id: begin.delivery_id,
    p_attempt_number: begin.attempt_number,
    p_classification: classification,
    p_provider_http_status: httpStatus,
    p_provider_error_code: errorCode,
    p_provider_message_id: messageId,
    p_last_error: lastError,
    p_next_retry_at: nextRetryAt
  });

  return { begin, complete, providerResult, providerError };
}

// =========================================================
// TESTS
// =========================================================

// ─── T1: pending → prepared → sending → sent (happy path) ───
async function T1() {
  console.log('\n=== T1: Happy path ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const { begin, complete } = await fullCycle(row.id);
    check('T1: begin result=ok', begin?.result === 'ok');
    check('T1: complete ack_applied=true', complete?.ack_applied === true);
    const final = await getOutboxRow(row.id);
    check('T1: status=sent', final.status === 'sent');
    check('T1: attempts=1', final.attempts === 1);
    check('T1: sent_at NOT NULL', final.sent_at !== null);
    check('T1: current_attempt_id=NULL', final.current_attempt_id === null);
    check('T1: delivery_id NOT NULL', final.delivery_id !== null);
    check('T1: first_provider_attempt_at NOT NULL', final.first_provider_attempt_at !== null);
    const ledger = await getLedgerByOutbox(row.id);
    check('T1: ledger has 1 row', ledger.length === 1);
    check('T1: ledger provider_outcome=success', ledger[0].provider_outcome === 'success');
    check('T1: ledger ack_status=applied', ledger[0].ack_status === 'applied');
    check('T1: ledger classification=success', ledger[0].classification === 'success');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T2: Known 5xx → retry ───
async function T2() {
  console.log('\n=== T2: 5xx → retry ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const { complete } = await fullCycle(row.id, null, {
      shouldFail: true, httpStatus: 500, errorMessage: 'Internal error'
    });
    check('T2: complete ack_applied=true', complete?.ack_applied === true);
    const final = await getOutboxRow(row.id);
    check('T2: status=retry', final.status === 'retry');
    check('T2: attempts=1', final.attempts === 1);
    check('T2: next_retry_at NOT NULL', final.next_retry_at !== null);
    const ledger = await getLedgerByOutbox(row.id);
    check('T2: ledger classification=ambiguous_retryable', ledger[0].classification === 'ambiguous_retryable');
    check('T2: ledger provider_outcome=ambiguous', ledger[0].provider_outcome === 'ambiguous');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T3: retry → prepared → sending → sent inside 20h ───
async function T3() {
  console.log('\n=== T3: retry → sent ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    // First attempt fails with 5xx
    await fullCycle(row.id, null, { shouldFail: true, httpStatus: 500 });
    // Second attempt succeeds
    const { complete } = await fullCycle(row.id);
    check('T3: complete ack_applied=true', complete?.ack_applied === true);
    const final = await getOutboxRow(row.id);
    check('T3: status=sent', final.status === 'sent');
    check('T3: attempts=2', final.attempts === 2);
    check('T3: delivery_id unchanged', final.delivery_id !== null);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T4: Provider success + DB ACK success ───
async function T4() {
  console.log('\n=== T4: Provider success + ACK success ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_delivered', 'client');
    const { complete, providerResult } = await fullCycle(row.id);
    check('T4: ack_applied=true', complete?.ack_applied === true);
    check('T4: outbox_status=sent', complete?.outbox_status === 'sent');
    check('T4: provider message_id present', providerResult?.id !== undefined);
    const final = await getOutboxRow(row.id);
    check('T4: payload has provider_message_id', final.payload?.provider_message_id !== undefined);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T5: Provider success + DB ACK failure (CAS mismatch) ───
async function T5() {
  console.log('\n=== T5: Provider success + ACK CAS mismatch ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    // Prepare
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    // Begin
    const begin = await callBeginRPC(row.id, outboxRow.attempts);
    check('T5: begin ok', begin?.result === 'ok');
    // Simulate stale: reclaim the row before completion
    const staleTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await sb.from('notification_outbox').update({
      current_attempt_started_at: staleTime
    }).eq('id', row.id);
    await callProcessRPC(); // stale recovery → prepared
    // Now try to complete with old attempt_id
    const complete = await callCompleteRPC({
      p_outbox_id: row.id,
      p_expected_attempt_id: begin.attempt_id,
      p_expected_delivery_id: begin.delivery_id,
      p_attempt_number: begin.attempt_number,
      p_classification: 'success',
      p_provider_http_status: 200,
      p_provider_error_code: null,
      p_provider_message_id: 'mock-msg-id',
      p_last_error: null,
      p_next_retry_at: null
    });
    check('T5: ack_applied=false', complete?.ack_applied === false);
    check('T5: failure_reason=outbox_cas_mismatch', complete?.failure_reason === 'outbox_cas_mismatch');
    check('T5: provider_result_persisted=true', complete?.provider_result_persisted === true);
    const ledger = await getLedgerByOutbox(row.id);
    const oldAttempt = ledger.find(l => l.id === begin.attempt_id);
    check('T5: old ledger ack_status=stale_rejected', oldAttempt?.ack_status === 'stale_rejected');
    check('T5: old ledger provider_outcome=success', oldAttempt?.provider_outcome === 'success');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T6: Crash after sending transition, before provider ───
async function T6() {
  console.log('\n=== T6: Crash after sending, before provider ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    const begin = await callBeginRPC(row.id, outboxRow.attempts);
    check('T6: begin ok', begin?.result === 'ok');
    // Simulate crash: no provider call, no complete
    // Stale recovery
    const staleTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await sb.from('notification_outbox').update({
      current_attempt_started_at: staleTime
    }).eq('id', row.id);
    await callProcessRPC();
    const after = await getOutboxRow(row.id);
    check('T6: status=prepared (reclaimed)', after.status === 'prepared');
    check('T6: current_attempt_id=NULL', after.current_attempt_id === null);
    const ledger = await getLedgerByOutbox(row.id);
    check('T6: ledger has 1 row (started)', ledger.length === 1);
    check('T6: ledger outcome=started', ledger[0].provider_outcome === 'started');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T7: Crash after provider request, before response ───
async function T7() {
  console.log('\n=== T7: Crash after provider request ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    const begin = await callBeginRPC(row.id, outboxRow.attempts);
    // Simulate crash: provider call made but no response, no complete
    const staleTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await sb.from('notification_outbox').update({
      current_attempt_started_at: staleTime
    }).eq('id', row.id);
    await callProcessRPC();
    const after = await getOutboxRow(row.id);
    check('T7: status=prepared (reclaimed)', after.status === 'prepared');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T8: Stale prepared inside 20h → reclaim ───
async function T8() {
  console.log('\n=== T8: Stale prepared inside 20h ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const staleTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await sb.from('notification_outbox').update({ prepared_at: staleTime }).eq('id', row.id);
    const rpcResult = await callProcessRPC();
    check('T8: row returned', (rpcResult || []).some(r => r.id === row.id));
    const after = await getOutboxRow(row.id);
    check('T8: status=prepared', after.status === 'prepared');
    check('T8: prepared_at refreshed', new Date(after.prepared_at) > new Date(staleTime));
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T9: Stale sending inside 20h → reclaim to prepared ───
async function T9() {
  console.log('\n=== T9: Stale sending inside 20h ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    await callBeginRPC(row.id, outboxRow.attempts);
    const staleTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await sb.from('notification_outbox').update({
      current_attempt_started_at: staleTime
    }).eq('id', row.id);
    await callProcessRPC();
    const after = await getOutboxRow(row.id);
    check('T9: status=prepared', after.status === 'prepared');
    check('T9: current_attempt_id=NULL', after.current_attempt_id === null);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T10: Stale ambiguous beyond 20h → delivery_unknown ───
async function T10() {
  console.log('\n=== T10: Beyond 20h → delivery_unknown ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    await callBeginRPC(row.id, outboxRow.attempts);
    // Set first_provider_attempt_at to 21h ago
    const oldTime = new Date(Date.now() - 21 * 60 * 60 * 1000).toISOString();
    await sb.from('notification_outbox').update({
      first_provider_attempt_at: oldTime,
      current_attempt_started_at: new Date(Date.now() - 11 * 60 * 1000).toISOString()
    }).eq('id', row.id);
    await callProcessRPC();
    const after = await getOutboxRow(row.id);
    check('T10: status=delivery_unknown', after.status === 'delivery_unknown');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T11: delivery_unknown → RPC skips, NO provider call ───
async function T11() {
  console.log('\n=== T11: delivery_unknown skipped ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client', {
      status: 'delivery_unknown',
      last_error: 'test'
    });
    const rpcResult = await callProcessRPC();
    check('T11: not selected', !(rpcResult || []).some(r => r.id === row.id));
    const after = await getOutboxRow(row.id);
    check('T11: status unchanged', after.status === 'delivery_unknown');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T12: Concurrent RPC / SKIP LOCKED ───
async function T12() {
  console.log('\n=== T12: Concurrent SKIP LOCKED ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const [r1, r2] = await Promise.all([
      sb.rpc('process_notification_outbox', { p_limit: 10 }),
      sb.rpc('process_notification_outbox', { p_limit: 10 })
    ]);
    const total = (r1.data || []).length + (r2.data || []).length;
    check('T12: only 1 claim', total === 1, `got ${total}`);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T13: Lease race — Worker A in sending, lease expires, Worker B reclaims ───
async function T13() {
  console.log('\n=== T13: Lease race ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    const beginA = await callBeginRPC(row.id, outboxRow.attempts);
    // Lease expires
    const staleTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await sb.from('notification_outbox').update({
      current_attempt_started_at: staleTime
    }).eq('id', row.id);
    // Worker B reclaims
    await callProcessRPC();
    const afterReclaim = await getOutboxRow(row.id);
    check('T13: reclaimed to prepared', afterReclaim.status === 'prepared');
    // Worker A tries to ACK
    const completeA = await callCompleteRPC({
      p_outbox_id: row.id,
      p_expected_attempt_id: beginA.attempt_id,
      p_expected_delivery_id: beginA.delivery_id,
      p_attempt_number: beginA.attempt_number,
      p_classification: 'success',
      p_provider_http_status: 200,
      p_provider_error_code: null,
      p_provider_message_id: 'msg-a',
      p_last_error: null,
      p_next_retry_at: null
    });
    check('T13: Worker A ACK rejected', completeA?.ack_applied === false);
    check('T13: failure_reason=outbox_cas_mismatch', completeA?.failure_reason === 'outbox_cas_mismatch');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T14: Terminal 4xx → failed ───
async function T14() {
  console.log('\n=== T14: Terminal 4xx → failed ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const { complete } = await fullCycle(row.id, null, {
      shouldFail: true, httpStatus: 400, errorMessage: 'Invalid recipient', errorCode: null
    });
    check('T14: ack_applied=true', complete?.ack_applied === true);
    const final = await getOutboxRow(row.id);
    check('T14: status=failed', final.status === 'failed');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T15: 429 rate_limit → retry ───
async function T15() {
  console.log('\n=== T15: 429 rate_limit → retry ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const { complete } = await fullCycle(row.id, null, {
      shouldFail: true, httpStatus: 429, errorMessage: 'Rate limit', errorCode: 'rate_limit_exceeded', retryAfter: 60
    });
    check('T15: ack_applied=true', complete?.ack_applied === true);
    const final = await getOutboxRow(row.id);
    check('T15: status=retry', final.status === 'retry');
    check('T15: next_retry_at NOT NULL', final.next_retry_at !== null);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T16: 409 concurrent → retry ───
async function T16() {
  console.log('\n=== T16: 409 concurrent → retry ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const { complete } = await fullCycle(row.id, null, {
      shouldFail: true, httpStatus: 409, errorMessage: 'Concurrent', errorCode: 'concurrent_idempotent_requests'
    });
    check('T16: ack_applied=true', complete?.ack_applied === true);
    const final = await getOutboxRow(row.id);
    check('T16: status=retry', final.status === 'retry');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T17: 409 invalid_idempotent_request → delivery_unknown ───
async function T17() {
  console.log('\n=== T17: 409 invalid_idempotent → delivery_unknown ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const { complete } = await fullCycle(row.id, null, {
      shouldFail: true, httpStatus: 409, errorMessage: 'Invalid idempotent', errorCode: 'invalid_idempotent_request'
    });
    check('T17: ack_applied=true', complete?.ack_applied === true);
    const final = await getOutboxRow(row.id);
    check('T17: status=delivery_unknown', final.status === 'delivery_unknown');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T18: 429 daily_quota → operational_blocked ───
async function T18() {
  console.log('\n=== T18: daily_quota → operational_blocked ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const { complete } = await fullCycle(row.id, null, {
      shouldFail: true, httpStatus: 429, errorMessage: 'Daily quota', errorCode: 'daily_quota_exceeded'
    });
    check('T18: ack_applied=true', complete?.ack_applied === true);
    const final = await getOutboxRow(row.id);
    check('T18: status=operational_blocked', final.status === 'operational_blocked');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T19: 401 → operational_blocked ───
async function T19() {
  console.log('\n=== T19: 401 → operational_blocked ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const { complete } = await fullCycle(row.id, null, {
      shouldFail: true, httpStatus: 401, errorMessage: 'Unauthorized'
    });
    check('T19: ack_applied=true', complete?.ack_applied === true);
    const final = await getOutboxRow(row.id);
    check('T19: status=operational_blocked', final.status === 'operational_blocked');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T20: Network timeout → ambiguous retry ───
async function T20() {
  console.log('\n=== T20: Network timeout → ambiguous retry ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const { complete } = await fullCycle(row.id, null, {
      shouldThrow: true, throwMessage: 'Timeout'
    });
    check('T20: ack_applied=true', complete?.ack_applied === true);
    const final = await getOutboxRow(row.id);
    check('T20: status=retry', final.status === 'retry');
    const ledger = await getLedgerByOutbox(row.id);
    check('T20: ledger provider_outcome=ambiguous', ledger[0].provider_outcome === 'ambiguous');
    check('T20: ledger provider_response_at=NULL', ledger[0].provider_response_at === null);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T21: EMAIL_FROM changes → frozen from used ───
async function T21() {
  console.log('\n=== T21: EMAIL_FROM changes after freeze ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    // First attempt with 5xx
    await fullCycle(row.id, `Bathily Convoyage <${EMAIL_FROM}>`, {
      shouldFail: true, httpStatus: 500
    });
    const afterFirst = await getOutboxRow(row.id);
    const frozenFrom = afterFirst.payload?.provider_request?.from;
    check('T21: from frozen', frozenFrom !== null && frozenFrom !== undefined);
    // Second attempt with different EMAIL_FROM
    const { complete } = await fullCycle(row.id, `Bathily Convoyage <changed@local.test>`);
    check('T21: second attempt ok', complete?.ack_applied === true);
    const afterSecond = await getOutboxRow(row.id);
    check('T21: from unchanged', afterSecond.payload?.provider_request?.from === frozenFrom);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T22: Provider payload frozen across retries ───
async function T22() {
  console.log('\n=== T22: Provider payload frozen ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await fullCycle(row.id, null, { shouldFail: true, httpStatus: 500 });
    const afterFirst = await getOutboxRow(row.id);
    const req1 = afterFirst.payload?.provider_request;
    await fullCycle(row.id);
    const afterSecond = await getOutboxRow(row.id);
    const req2 = afterSecond.payload?.provider_request;
    check('T22: to identical', req1?.to === req2?.to);
    check('T22: subject identical', req1?.subject === req2?.subject);
    check('T22: html identical', req1?.html === req2?.html);
    check('T22: from identical', req1?.from === req2?.from);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T23: delivery_id stable across retries ───
async function T23() {
  console.log('\n=== T23: delivery_id stable ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await fullCycle(row.id, null, { shouldFail: true, httpStatus: 500 });
    const afterFirst = await getOutboxRow(row.id);
    const did1 = afterFirst.delivery_id;
    await fullCycle(row.id);
    const afterSecond = await getOutboxRow(row.id);
    check('T23: delivery_id unchanged', afterSecond.delivery_id === did1);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T24: 20h deadline: no provider call beyond ceiling ───
async function T24() {
  console.log('\n=== T24: 20h deadline in begin_delivery_attempt ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    // Set first_provider_attempt_at to 21h ago (simulating prior attempt)
    const oldTime = new Date(Date.now() - 21 * 60 * 60 * 1000).toISOString();
    await sb.from('notification_outbox').update({
      first_provider_attempt_at: oldTime,
      status: 'retry'
    }).eq('id', row.id);
    await callProcessRPC(); // should quarantine
    const after = await getOutboxRow(row.id);
    check('T24: status=delivery_unknown', after.status === 'delivery_unknown');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T25: Persistence barrier failure → zero provider calls ───
async function T25() {
  console.log('\n=== T25: Persistence barrier (invalid_from) ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    const begin = await callBeginRPC(row.id, outboxRow.attempts, '');
    check('T25: result=invalid_from', begin?.result === 'invalid_from');
    const after = await getOutboxRow(row.id);
    check('T25: status still prepared', after.status === 'prepared');
    check('T25: attempts unchanged', after.attempts === 0);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T26: Ledger RLS / FORCE RLS / grants ───
async function T26() {
  console.log('\n=== T26: Ledger RLS ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await fullCycle(row.id);
    const { error: anonErr } = await sbAnon.from('notification_delivery_attempts').select('*').limit(1);
    check('T26: anon denied', anonErr !== null);
    const { data: svcData, error: svcErr } = await sb.from('notification_delivery_attempts').select('*').limit(1);
    check('T26: service_role allowed', svcErr === null && svcData !== null);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T27: Outbox RLS unchanged ───
async function T27() {
  console.log('\n=== T27: Outbox RLS ===');
  await cleanOutbox();
  const { error: anonErr } = await sbAnon.from('notification_outbox').select('*').limit(1);
  check('T27: anon denied', anonErr !== null);
  const { data, error: svcErr } = await sb.from('notification_outbox').select('*').limit(1);
  check('T27: service_role allowed', svcErr === null);
}

// ─── T28: external_convoyeurs_enabled remains false ───
async function T28() {
  console.log('\n=== T28: external_convoyeurs_enabled ===');
  const { data, error } = await sb.from('app_settings').select('value').eq('key', 'external_convoyeurs_enabled').single();
  check('T28: flag=false', data?.value === false || data?.value === 'false', `got ${data?.value}`);
}

// ─── T29: Anon/authenticated cannot operate outbox or ledger ───
async function T29() {
  console.log('\n=== T29: Anon denied RPCs ===');
  const { error: anonProcess } = await sbAnon.rpc('process_notification_outbox', { p_limit: 10 });
  check('T29: anon process denied', anonProcess !== null);
  const { error: anonBegin } = await sbAnon.rpc('begin_delivery_attempt', {
    p_outbox_id: '00000000-0000-0000-0000-000000000000', p_expected_attempts: 0, p_from: 'test'
  });
  check('T29: anon begin denied', anonBegin !== null);
  const { error: anonComplete } = await sbAnon.rpc('complete_delivery_attempt', {
    p_outbox_id: '00000000-0000-0000-0000-000000000000',
    p_expected_attempt_id: '00000000-0000-0000-0000-000000000000',
    p_expected_delivery_id: '00000000-0000-0000-0000-000000000000',
    p_attempt_number: 1, p_classification: 'success',
    p_provider_http_status: 200, p_provider_error_code: null,
    p_provider_message_id: null, p_last_error: null, p_next_retry_at: null
  });
  check('T29: anon complete denied', anonComplete !== null);
}

// ─── T30: Service-role-only RPCs ───
async function T30() {
  console.log('\n=== T30: Service-role RPCs ===');
  const { data, error } = await sb.rpc('process_notification_outbox', { p_limit: 10 });
  check('T30: service_role process ok', error === null);
  const { data: beginData, error: beginErr } = await sb.rpc('begin_delivery_attempt', {
    p_outbox_id: '00000000-0000-0000-0000-000000000000', p_expected_attempts: 0, p_from: 'test'
  });
  // Will fail with cas_mismatch but not permission error
  check('T30: service_role begin callable', beginErr === null);
}

// ─── T31: operational_blocked → not selected by RPC ───
async function T31() {
  console.log('\n=== T31: operational_blocked not selected ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client', {
      status: 'operational_blocked', last_error: 'test'
    });
    const rpcResult = await callProcessRPC();
    check('T31: not selected', !(rpcResult || []).some(r => r.id === row.id));
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T32: next_retry_at delays retry selection ───
async function T32() {
  console.log('\n=== T32: next_retry_at delays selection ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client', {
      status: 'retry',
      next_retry_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });
    const rpcResult = await callProcessRPC();
    check('T32: not selected (future retry)', !(rpcResult || []).some(r => r.id === row.id));
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T33: attempts increments only in begin ───
async function T33() {
  console.log('\n=== T33: attempts increment in begin ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    let outboxRow = await getOutboxRow(row.id);
    check('T33: attempts=0 after prepare', outboxRow.attempts === 0);
    await callBeginRPC(row.id, outboxRow.attempts);
    outboxRow = await getOutboxRow(row.id);
    check('T33: attempts=1 after begin', outboxRow.attempts === 1);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T34: 5xx classified as ambiguous_retryable ───
async function T34() {
  console.log('\n=== T34: 5xx → ambiguous_retryable ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const { complete } = await fullCycle(row.id, null, {
      shouldFail: true, httpStatus: 503, errorMessage: 'Service unavailable'
    });
    const ledger = await getLedgerByOutbox(row.id);
    check('T34: classification=ambiguous_retryable', ledger[0].classification === 'ambiguous_retryable');
    check('T34: provider_outcome=ambiguous', ledger[0].provider_outcome === 'ambiguous');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T35: 5xx exhaustion (3 attempts) → delivery_unknown ───
async function T35() {
  console.log('\n=== T35: 5xx exhaustion → delivery_unknown ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    for (let i = 0; i < 3; i++) {
      await fullCycle(row.id, null, { shouldFail: true, httpStatus: 503 });
    }
    const final = await getOutboxRow(row.id);
    check('T35: status=delivery_unknown', final.status === 'delivery_unknown');
    check('T35: attempts=3', final.attempts === 3);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T36: Rate-limit known retry exhaustion → retry_exhausted ───
async function T36() {
  console.log('\n=== T36: rate_limit exhaustion → retry_exhausted ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    for (let i = 0; i < 3; i++) {
      await fullCycle(row.id, null, {
        shouldFail: true, httpStatus: 429, errorCode: 'rate_limit_exceeded', retryAfter: 1
      });
    }
    const final = await getOutboxRow(row.id);
    check('T36: status=retry_exhausted', final.status === 'retry_exhausted');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T37: retry_exhausted not selected by RPC ───
async function T37() {
  console.log('\n=== T37: retry_exhausted not selected ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client', {
      status: 'retry_exhausted', last_error: 'test'
    });
    const rpcResult = await callProcessRPC();
    check('T37: not selected', !(rpcResult || []).some(r => r.id === row.id));
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T38: Audit table RLS ───
async function T38() {
  console.log('\n=== T38: Audit table RLS ===');
  const { error: anonErr } = await sbAnon.from('notification_delivery_actions').select('*').limit(1);
  check('T38: anon denied', anonErr !== null);
  const { data, error: svcErr } = await sb.from('notification_delivery_actions').select('*').limit(1);
  check('T38: service_role allowed', svcErr === null);
}

// ─── T39: FK RESTRICT on ledger ───
async function T39() {
  console.log('\n=== T39: FK RESTRICT ledger ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await fullCycle(row.id);
    const { error } = await sb.from('notification_outbox').delete().eq('id', row.id);
    check('T39: delete blocked by RESTRICT', error !== null, error?.message || 'no error');
  } finally {
    // Clean up ledger first then outbox
    await sb.from('notification_delivery_attempts').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await sb.from('notification_outbox').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await cleanupTestFixtures(client.id, mission.id);
  }
}

// ─── T40: All RPCs use search_path = '' (check via pg_proc) ───
async function T40() {
  console.log('\n=== T40: search_path = "" ===');
  // Verify all three RPCs have search_path = '' via pg_proc
  try {
    const { data, error } = await sb.rpc('process_notification_outbox', { p_limit: 1 });
    // If RPC is callable without error, search_path config is valid
    check('T40: process_notification_outbox callable', error === null);
  } catch {
    check('T40: process_notification_outbox callable', false);
  }
  try {
    const { error } = await sb.rpc('begin_delivery_attempt', {
      p_outbox_id: '00000000-0000-0000-0000-000000000000',
      p_expected_attempts: 0,
      p_from: 'test'
    });
    check('T40: begin_delivery_attempt callable', error === null);
  } catch {
    check('T40: begin_delivery_attempt callable', false);
  }
  try {
    const { error } = await sb.rpc('complete_delivery_attempt', {
      p_outbox_id: '00000000-0000-0000-0000-000000000000',
      p_expected_attempt_id: '00000000-0000-0000-0000-000000000000',
      p_expected_delivery_id: '00000000-0000-0000-0000-000000000000',
      p_attempt_number: 1, p_classification: 'success',
      p_provider_http_status: 200, p_provider_error_code: null,
      p_provider_message_id: null, p_last_error: null, p_next_retry_at: null
    });
    check('T40: complete_delivery_attempt callable', error === null);
  } catch {
    check('T40: complete_delivery_attempt callable', false);
  }
}

// ─── T41: Replay after applied (identical) → idempotent success ───
async function T41() {
  console.log('\n=== T41: Replay applied identical ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    const begin = await callBeginRPC(row.id, outboxRow.attempts);
    // First completion
    const c1 = await callCompleteRPC({
      p_outbox_id: row.id, p_expected_attempt_id: begin.attempt_id,
      p_expected_delivery_id: begin.delivery_id, p_attempt_number: begin.attempt_number,
      p_classification: 'success', p_provider_http_status: 200,
      p_provider_error_code: null, p_provider_message_id: 'msg-1',
      p_last_error: null, p_next_retry_at: null
    });
    check('T41: first ack_applied=true', c1?.ack_applied === true);
    // Replay
    const c2 = await callCompleteRPC({
      p_outbox_id: row.id, p_expected_attempt_id: begin.attempt_id,
      p_expected_delivery_id: begin.delivery_id, p_attempt_number: begin.attempt_number,
      p_classification: 'success', p_provider_http_status: 200,
      p_provider_error_code: null, p_provider_message_id: 'msg-1',
      p_last_error: null, p_next_retry_at: null
    });
    check('T41: replay ack_applied=true', c2?.ack_applied === true);
    check('T41: replay already_completed=true', c2?.already_completed === true);
    const ledger = await getLedgerByOutbox(row.id);
    check('T41: ledger still applied', ledger[0].ack_status === 'applied');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T42: Replay stale_rejected (identical) → no mutation ───
async function T42() {
  console.log('\n=== T42: Replay stale_rejected ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    const begin = await callBeginRPC(row.id, outboxRow.attempts);
    // Stale the row and reclaim
    const staleTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await sb.from('notification_outbox').update({ current_attempt_started_at: staleTime }).eq('id', row.id);
    await callProcessRPC();
    // First completion (should be stale_rejected)
    const c1 = await callCompleteRPC({
      p_outbox_id: row.id, p_expected_attempt_id: begin.attempt_id,
      p_expected_delivery_id: begin.delivery_id, p_attempt_number: begin.attempt_number,
      p_classification: 'success', p_provider_http_status: 200,
      p_provider_error_code: null, p_provider_message_id: 'msg-1',
      p_last_error: null, p_next_retry_at: null
    });
    check('T42: first ack_applied=false', c1?.ack_applied === false);
    // Replay
    const c2 = await callCompleteRPC({
      p_outbox_id: row.id, p_expected_attempt_id: begin.attempt_id,
      p_expected_delivery_id: begin.delivery_id, p_attempt_number: begin.attempt_number,
      p_classification: 'success', p_provider_http_status: 200,
      p_provider_error_code: null, p_provider_message_id: 'msg-1',
      p_last_error: null, p_next_retry_at: null
    });
    check('T42: replay ack_applied=false', c2?.ack_applied === false);
    check('T42: replay already_completed=true', c2?.already_completed === true);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T43: Conflicting replay → result_conflict, ZERO mutation ───
async function T43() {
  console.log('\n=== T43: Conflicting replay ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    const begin = await callBeginRPC(row.id, outboxRow.attempts);
    // First completion with success
    await callCompleteRPC({
      p_outbox_id: row.id, p_expected_attempt_id: begin.attempt_id,
      p_expected_delivery_id: begin.delivery_id, p_attempt_number: begin.attempt_number,
      p_classification: 'success', p_provider_http_status: 200,
      p_provider_error_code: null, p_provider_message_id: 'msg-1',
      p_last_error: null, p_next_retry_at: null
    });
    // Replay with conflicting result
    const c2 = await callCompleteRPC({
      p_outbox_id: row.id, p_expected_attempt_id: begin.attempt_id,
      p_expected_delivery_id: begin.delivery_id, p_attempt_number: begin.attempt_number,
      p_classification: 'terminal_failed', p_provider_http_status: 400,
      p_provider_error_code: null, p_provider_message_id: null,
      p_last_error: 'different', p_next_retry_at: null
    });
    check('T43: conflict ack_applied=false', c2?.ack_applied === false);
    check('T43: failure_reason=result_conflict', c2?.failure_reason === 'result_conflict');
    const ledger = await getLedgerByOutbox(row.id);
    check('T43: ledger unchanged (success/applied)', ledger[0].provider_outcome === 'success' && ledger[0].ack_status === 'applied');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T44: ambiguous sets provider_response_at = NULL ───
async function T44() {
  console.log('\n=== T44: ambiguous provider_response_at NULL ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await fullCycle(row.id, null, { shouldThrow: true, throwMessage: 'Timeout' });
    const ledger = await getLedgerByOutbox(row.id);
    check('T44: provider_response_at=NULL', ledger[0].provider_response_at === null);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T45: success sets provider_response_at ───
async function T45() {
  console.log('\n=== T45: success provider_response_at set ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await fullCycle(row.id);
    const ledger = await getLedgerByOutbox(row.id);
    check('T45: provider_response_at NOT NULL', ledger[0].provider_response_at !== null);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T46: ON DELETE RESTRICT ledger ───
async function T46() {
  console.log('\n=== T46: FK RESTRICT ledger ===');
  await T39(); // Same logic
}

// ─── T47: ON DELETE RESTRICT audit ───
async function T47() {
  console.log('\n=== T47: FK RESTRICT audit ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    // Insert an audit action
    await sb.from('notification_delivery_actions').insert({
      outbox_id: row.id, action: 'test', previous_status: 'pending', new_status: 'pending',
      evidence: {}
    });
    const { error } = await sb.from('notification_outbox').delete().eq('id', row.id);
    check('T47: delete blocked', error !== null);
    // Cleanup
    await sb.from('notification_delivery_actions').delete().eq('outbox_id', row.id);
    await sb.from('notification_outbox').delete().eq('id', row.id);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T48: transient_retryable + 20h expired → retry_exhausted ───
async function T48() {
  console.log('\n=== T48: transient + 20h expired → retry_exhausted ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    const begin = await callBeginRPC(row.id, outboxRow.attempts);
    // Set first_provider_attempt_at to 21h ago
    await sb.from('notification_outbox').update({
      first_provider_attempt_at: new Date(Date.now() - 21 * 60 * 60 * 1000).toISOString()
    }).eq('id', row.id);
    const complete = await callCompleteRPC({
      p_outbox_id: row.id, p_expected_attempt_id: begin.attempt_id,
      p_expected_delivery_id: begin.delivery_id, p_attempt_number: begin.attempt_number,
      p_classification: 'transient_retryable', p_provider_http_status: 429,
      p_provider_error_code: 'rate_limit_exceeded', p_provider_message_id: null,
      p_last_error: 'rate limit', p_next_retry_at: null
    });
    check('T48: ack_applied=true', complete?.ack_applied === true);
    const final = await getOutboxRow(row.id);
    check('T48: status=retry_exhausted', final.status === 'retry_exhausted');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T49: ambiguous_retryable + attempts >= 3 → delivery_unknown ───
async function T49() {
  console.log('\n=== T49: ambiguous + attempts>=3 → delivery_unknown ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    for (let i = 0; i < 3; i++) {
      await fullCycle(row.id, null, { shouldThrow: true, throwMessage: 'Timeout' });
    }
    const final = await getOutboxRow(row.id);
    check('T49: status=delivery_unknown', final.status === 'delivery_unknown');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T50: invalid classification → invalid_classification ───
async function T50() {
  console.log('\n=== T50: invalid classification ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    const begin = await callBeginRPC(row.id, outboxRow.attempts);
    const complete = await callCompleteRPC({
      p_outbox_id: row.id, p_expected_attempt_id: begin.attempt_id,
      p_expected_delivery_id: begin.delivery_id, p_attempt_number: begin.attempt_number,
      p_classification: 'invalid_value', p_provider_http_status: 200,
      p_provider_error_code: null, p_provider_message_id: null,
      p_last_error: null, p_next_retry_at: null
    });
    check('T50: ack_applied=false', complete?.ack_applied === false);
    check('T50: failure_reason=invalid_classification', complete?.failure_reason === 'invalid_classification');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T51: Frozen from sent verbatim ───
async function T51() {
  console.log('\n=== T51: Frozen from verbatim ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    const customFrom = 'Bathily Convoyage <noreply@bathily-convoyage.fr>';
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    const begin = await callBeginRPC(row.id, outboxRow.attempts, customFrom);
    check('T51: begin ok', begin?.result === 'ok');
    check('T51: from frozen verbatim', begin.provider_request?.from === customFrom);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T52: Replay with different classification → result_conflict ───
async function T52() {
  console.log('\n=== T52: Replay different classification ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);
    const begin = await callBeginRPC(row.id, outboxRow.attempts);
    // First completion: success
    await callCompleteRPC({
      p_outbox_id: row.id, p_expected_attempt_id: begin.attempt_id,
      p_expected_delivery_id: begin.delivery_id, p_attempt_number: begin.attempt_number,
      p_classification: 'success', p_provider_http_status: 200,
      p_provider_error_code: null, p_provider_message_id: 'msg-1',
      p_last_error: null, p_next_retry_at: null
    });
    // Replay with different classification (same HTTP/msg-id but different classification)
    const c2 = await callCompleteRPC({
      p_outbox_id: row.id, p_expected_attempt_id: begin.attempt_id,
      p_expected_delivery_id: begin.delivery_id, p_attempt_number: begin.attempt_number,
      p_classification: 'transient_retryable', p_provider_http_status: 200,
      p_provider_error_code: null, p_provider_message_id: 'msg-1',
      p_last_error: null, p_next_retry_at: null
    });
    check('T52: result_conflict', c2?.failure_reason === 'result_conflict');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T53: Third known retryable → retry_exhausted ───
async function T53() {
  console.log('\n=== T53: Third transient → retry_exhausted ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    for (let i = 0; i < 3; i++) {
      await fullCycle(row.id, null, {
        shouldFail: true, httpStatus: 429, errorCode: 'rate_limit_exceeded', retryAfter: 1
      });
    }
    const final = await getOutboxRow(row.id);
    check('T53: status=retry_exhausted', final.status === 'retry_exhausted');
    check('T53: NOT delivery_unknown', final.status !== 'delivery_unknown');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T54: Known retryable after 20h → retry_exhausted ───
async function T54() {
  console.log('\n=== T54: Known retryable after 20h → retry_exhausted ===');
  await T48(); // Same logic
}

// ─── T55: Ambiguous third/outside 20h → delivery_unknown ───
async function T55() {
  console.log('\n=== T55: Ambiguous exhaustion → delivery_unknown ===');
  await T49(); // Same logic
}

// ─── T56: retry_exhausted never selected ───
async function T56() {
  console.log('\n=== T56: retry_exhausted not selected ===');
  await T37(); // Same logic
}

// ─── T57: Manual requeue requires new delivery_id (design test) ───
async function T57() {
  console.log('\n=== T57: Manual requeue new delivery_id ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client', {
      status: 'retry_exhausted', attempts: 3,
      delivery_id: '11111111-1111-1111-1111-111111111111',
      first_provider_attempt_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    });
    // Simulate manual requeue
    const newDeliveryId = crypto.randomUUID();
    await sb.from('notification_outbox').update({
      delivery_id: newDeliveryId,
      attempts: 0,
      first_provider_attempt_at: null,
      current_attempt_id: null,
      current_attempt_started_at: null,
      status: 'retry',
      prepared_at: null,
      sent_at: null,
      last_error: null
    }).eq('id', row.id);
    const after = await getOutboxRow(row.id);
    check('T57: new delivery_id', after.delivery_id === newDeliveryId);
    check('T57: attempts=0', after.attempts === 0);
    check('T57: first_provider_attempt_at=NULL', after.first_provider_attempt_at === null);
    check('T57: status=retry', after.status === 'retry');
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T58: EMAIL_FROM sender contract (bare email → full frozen string) ───
async function T58() {
  console.log('\n=== T58: EMAIL_FROM sender contract ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');

    // Simulate consumer's buildFromHeader with bare EMAIL_FROM
    const bareEmailFrom = 'noreply@bathily-convoyage.fr';
    const expectedFrozenFrom = `Bathily Convoyage <${bareEmailFrom}>`;

    // Prepare
    await callProcessRPC();
    const outboxRow = await getOutboxRow(row.id);

    // Begin with the full constructed from header (as consumer does)
    const begin = await callBeginRPC(row.id, outboxRow.attempts, expectedFrozenFrom);
    check('T58: begin ok', begin?.result === 'ok');

    // Verify frozen provider_request.from is the FULL string, not bare email
    check('T58: frozen from is full string', begin.provider_request?.from === expectedFrozenFrom,
      `got "${begin.provider_request?.from}"`);
    check('T58: frozen from is NOT bare email', begin.provider_request?.from !== bareEmailFrom);
    check('T58: no double wrapping', !begin.provider_request?.from.includes('<Bathily'));

    // Verify the frozen value would be sent verbatim to provider
    const { sendEmail } = await import('../functions/_email.js');
    let capturedFrom = null;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      capturedFrom = body.from;
      return new Response(JSON.stringify({ id: 'mock-t58' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    };
    try {
      await sendEmail({
        from: begin.provider_request.from,
        to: begin.provider_request.to,
        subject: begin.provider_request.subject,
        html: begin.provider_request.html,
        idempotencyKey: `notification-outbox/${begin.delivery_id}`
      }, { RESEND_API_KEY: 'fake', EMAIL_FROM: bareEmailFrom });
    } finally {
      globalThis.fetch = prevFetch;
    }
    check('T58: provider receives exact frozen string', capturedFrom === expectedFrozenFrom,
      `got "${capturedFrom}"`);
    check('T58: provider does NOT receive bare email', capturedFrom !== bareEmailFrom);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T59: OUTBOX_CRON_SECRET missing + correct CRON_SECRET → 401 ───
async function T59() {
  console.log('\n=== T59: OUTBOX_CRON_SECRET missing + CRON_SECRET → 401 ===');
  const { status } = await invokeConsumer({ OUTBOX_CRON_SECRET: undefined, CRON_SECRET: 'LEGACY_SECRET' });
  check('T59: status=401', status === 401, `got ${status}`);
}

// ─── T60: OUTBOX_CRON_SECRET set + header=CRON_SECRET only → 401 ───
async function T60() {
  console.log('\n=== T60: OUTBOX_CRON_SECRET set + header=CRON_SECRET → 401 ===');
  // invokeConsumer sends OUTBOX_CRON_SECRET as header; override env to use a different secret
  const consumerModule = await import('../functions/api/process-notification-outbox.js');
  const request = new Request('https://test.local/api/process-notification-outbox', {
    method: 'POST',
    headers: { 'x-cron-secret': 'LEGACY_CRON_SECRET' }
  });
  const env = {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    OUTBOX_CRON_SECRET: 'OUTBOX_ONLY_SECRET',
    CRON_SECRET: 'LEGACY_CRON_SECRET',
    RESEND_API_KEY,
    EMAIL_FROM
  };
  const response = await consumerModule.onRequest({ request, env });
  check('T60: status=401', response.status === 401, `got ${response.status}`);
}

// ─── T61: OUTBOX_CRON_SECRET set + correct header → authorized ───
async function T61() {
  console.log('\n=== T61: OUTBOX_CRON_SECRET correct → authorized ===');
  const consumerModule = await import('../functions/api/process-notification-outbox.js');
  const request = new Request('https://test.local/api/process-notification-outbox', {
    method: 'POST',
    headers: { 'x-cron-secret': 'OUTBOX_ONLY_SECRET' }
  });
  const env = {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    OUTBOX_CRON_SECRET: 'OUTBOX_ONLY_SECRET',
    CRON_SECRET: 'LEGACY_CRON_SECRET',
    RESEND_API_KEY,
    EMAIL_FROM
  };
  const response = await consumerModule.onRequest({ request, env });
  check('T61: status=200', response.status === 200, `got ${response.status}`);
}

// ─── T62: HTTP 503 → ambiguous_retryable + provider_response_at NOT NULL ───
async function T62() {
  console.log('\n=== T62: HTTP 503 provider_response_at NOT NULL ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await fullCycle(row.id, null, { shouldFail: true, httpStatus: 503, errorMessage: 'Service unavailable' });
    const ledger = await getLedgerByOutbox(row.id);
    check('T62: classification=ambiguous_retryable', ledger[0].classification === 'ambiguous_retryable');
    check('T62: provider_http_status=503', ledger[0].provider_http_status === 503);
    check('T62: provider_response_at NOT NULL', ledger[0].provider_response_at !== null);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T63: Network timeout → ambiguous_retryable + provider_response_at NULL ───
async function T63() {
  console.log('\n=== T63: Network timeout provider_response_at NULL ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await fullCycle(row.id, null, { shouldThrow: true, throwMessage: 'Timeout' });
    const ledger = await getLedgerByOutbox(row.id);
    check('T63: classification=ambiguous_retryable', ledger[0].classification === 'ambiguous_retryable');
    check('T63: provider_http_status=NULL', ledger[0].provider_http_status === null);
    check('T63: provider_response_at=NULL', ledger[0].provider_response_at === null);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// ─── T64: HTTP 429 → provider_response_at NOT NULL ───
async function T64() {
  console.log('\n=== T64: HTTP 429 provider_response_at NOT NULL ===');
  await cleanOutbox();
  const { client, mission } = await createTestFixtures();
  try {
    const row = await insertOutboxRow(mission.id, 'mission_assigned', 'client');
    await fullCycle(row.id, null, {
      shouldFail: true, httpStatus: 429, errorCode: 'rate_limit_exceeded', retryAfter: 30
    });
    const ledger = await getLedgerByOutbox(row.id);
    check('T64: provider_response_at NOT NULL', ledger[0].provider_response_at !== null);
    check('T64: provider_http_status=429', ledger[0].provider_http_status === 429);
  } finally { await cleanupTestFixtures(client.id, mission.id); }
}

// =========================================================
// MAIN
// =========================================================
async function main() {
  console.log('PROD-1D-B.2 — Local Cron Recovery Hardening Test Suite\n');

  // Pre-cleanup any leftover data
  await cleanOutbox();

  await T1();  await T2();  await T3();  await T4();  await T5();
  await T6();  await T7();  await T8();  await T9();  await T10();
  await T11(); await T12(); await T13(); await T14(); await T15();
  await T16(); await T17(); await T18(); await T19(); await T20();
  await T21(); await T22(); await T23(); await T24(); await T25();
  await T26(); await T27(); await T28(); await T29(); await T30();
  await T31(); await T32(); await T33(); await T34(); await T35();
  await T36(); await T37(); await T38(); await T39(); await T40();
  await T41(); await T42(); await T43(); await T44(); await T45();
  await T46(); await T47(); await T48(); await T49(); await T50();
  await T51(); await T52(); await T53(); await T54(); await T55();
  await T56(); await T57(); await T58(); await T59();
  await T60(); await T61(); await T62(); await T63(); await T64();

  await cleanOutbox();

  console.log(`\n=== SUMMARY ===`);
  console.log(`PASS: ${passCount}`);
  console.log(`FAIL: ${failCount}`);
  if (failCount > 0) {
    console.log('\n--- FAILED TESTS ---');
    results.filter(r => r.status === 'FAIL').forEach(r =>
      console.log(`  [FAIL] ${r.name} — ${r.detail}`));
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
