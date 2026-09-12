// RM-02C1 — Runtime integration tests (local Supabase required).
//
// Verifies:
//  - migration applied: global_adjust_percent row exists with default {"percent": 0}
//  - admin can SELECT/UPDATE system_settings (existing RLS sufficient)
//  - non-admin UPDATE denied
//  - /api/calculate-quote reads config server-side and adjusts B2C quotes
//  - B2B quotes unaffected by global_adjust_percent
//  - fallback to 0 when row missing/malformed
//
// Run: node --test tests/rm-02c1-global-adjust-runtime.test.mjs
//
// Requires local Supabase running. Get keys via: npx supabase status -o env

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { onRequest } from '../functions/api/calculate-quote.js';

const SUPABASE_URL = process.env.LOCAL_SUPABASE_URL || process.env.API_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.LOCAL_SUPABASE_ANON_KEY || process.env.ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// Safety: refuse to run against non-local Supabase
if (!SUPABASE_URL.includes('127.0.0.1') && !SUPABASE_URL.includes('localhost')) {
  console.error('ERROR: Refusing to run against non-local Supabase URL:', SUPABASE_URL);
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Helper: mock Cloudflare context with env for the Function
function makeContext(body = {}) {
  const request = new Request(SUPABASE_URL + '/api/calculate-quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost:5173' },
    body: JSON.stringify(body)
  });
  return {
    request,
    env: {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      SUPABASE_ANON_KEY: ANON_KEY
    }
  };
}

async function callApi(body) {
  const ctx = makeContext(body);
  const response = await onRequest(ctx);
  return { status: response.status, json: await response.json() };
}

// Helper: set global_adjust_percent via service role (bypasses RLS)
async function setGlobalAdjust(percent) {
  const { error } = await sb.from('system_settings')
    .upsert({ key: 'global_adjust_percent', value: { percent } }, { onConflict: 'key' });
  if (error) throw new Error(`Failed to set global_adjust_percent: ${error.message}`);
}

async function getGlobalAdjust() {
  const { data, error } = await sb.from('system_settings')
    .select('value').eq('key', 'global_adjust_percent').maybeSingle();
  if (error) throw new Error(`Failed to read global_adjust_percent: ${error.message}`);
  return data;
}

// =========================================================
// 1. MIGRATION VERIFICATION
// =========================================================
test('1. migration: global_adjust_percent row exists with default 0', async () => {
  const data = await getGlobalAdjust();
  assert.ok(data, 'global_adjust_percent row should exist');
  assert.equal(data.value.percent, 0, 'default percent should be 0');
});

test('1. migration: row is idempotent (re-insert does not duplicate)', async () => {
  // The migration uses ON CONFLICT DO NOTHING; verify only one row exists
  const { count, error } = await sb.from('system_settings')
    .select('*', { count: 'exact', head: true })
    .eq('key', 'global_adjust_percent');
  assert.ok(!error, 'count query should not error: ' + (error?.message || ''));
  assert.equal(count, 1, 'exactly one global_adjust_percent row should exist');
});

// =========================================================
// 2. ADMIN RLS (existing policies sufficient)
// =========================================================
test('2. RLS: admin can SELECT system_settings (via service role)', async () => {
  const { data, error } = await sb.from('system_settings')
    .select('key, value').eq('key', 'global_adjust_percent').maybeSingle();
  assert.ok(!error, 'service role SELECT should succeed');
  assert.ok(data);
  assert.equal(data.key, 'global_adjust_percent');
});

test('2. RLS: admin can UPDATE system_settings (via service role)', async () => {
  await setGlobalAdjust(0); // reset to 0 first
  const { data, error } = await sb.from('system_settings')
    .update({ value: { percent: 5 } })
    .eq('key', 'global_adjust_percent')
    .select().single();
  assert.ok(!error, 'service role UPDATE should succeed');
  assert.equal(data.value.percent, 5);
  // Restore to 0
  await setGlobalAdjust(0);
});

test('2. RLS: anon cannot UPDATE system_settings (denied by RLS/grant)', async () => {
  // Ensure known state
  await setGlobalAdjust(0);
  const sbAnon = createClient(SUPABASE_URL, ANON_KEY);
  const { error } = await sbAnon.from('system_settings')
    .update({ value: { percent: 999 } })
    .eq('key', 'global_adjust_percent');
  // anon has GRANT SELECT only (no UPDATE grant) + no UPDATE RLS policy for anon.
  // PostgREST may return an error OR silently affect 0 rows. Either way, the
  // persisted value must NOT change.
  const data = await getGlobalAdjust();
  assert.equal(data.value.percent, 0, 'anon must not be able to change global_adjust_percent');
});

// =========================================================
// 3. API CONFIG READ — B2C
// =========================================================
test('3. API: global_adjust=0 → B2C quote matches baseline', async () => {
  await setGlobalAdjust(0);
  const { status, json } = await callApi({
    depart: 'Paris, France', arrivee: 'Lyon, France',
    type: 'Automobile', mode: 'route', pack: 'excellence',
    isPro: false
  });
  assert.equal(status, 200);
  assert.equal(json.details.global_adjust_percent, 0);
  assert.equal(json.details.global_adjust_delta, 0);
  assert.equal(json.details.packPrice, 149);
});

test('3. API: global_adjust=+10 → B2C quote increased by transport delta', async () => {
  await setGlobalAdjust(10);
  try {
    const { status, json } = await callApi({
      depart: 'Paris, France', arrivee: 'Lyon, France',
      type: 'Automobile', mode: 'route', pack: 'excellence',
      isPro: false
    });
    assert.equal(status, 200);
    assert.equal(json.details.global_adjust_percent, 10);
    assert.ok(json.details.global_adjust_delta > 0, 'delta should be positive');
    assert.equal(json.details.packPrice, 149, 'pack price must not change');
  } finally {
    await setGlobalAdjust(0);
  }
});

test('3. API: global_adjust=-10 → B2C quote decreased by transport delta', async () => {
  await setGlobalAdjust(-10);
  try {
    const { status, json } = await callApi({
      depart: 'Paris, France', arrivee: 'Lyon, France',
      type: 'Automobile', mode: 'route', pack: 'excellence',
      isPro: false
    });
    assert.equal(status, 200);
    assert.equal(json.details.global_adjust_percent, -10);
    assert.ok(json.details.global_adjust_delta < 0, 'delta should be negative');
    assert.equal(json.details.packPrice, 149);
  } finally {
    await setGlobalAdjust(0);
  }
});

// =========================================================
// 4. B2B ISOLATION via API
// =========================================================
test('4. API B2B isolation: same B2B total for g=-10, 0, +10', async () => {
  const results = [];
  for (const g of [-10, 0, 10]) {
    await setGlobalAdjust(g);
    try {
      const { status, json } = await callApi({
        depart: 'Paris, France', arrivee: 'Lyon, France',
        type: 'Automobile', mode: 'route', pack: 'excellence',
        isPro: true
      });
      assert.equal(status, 200);
      assert.equal(json.details.global_adjust_percent, 0, `B2B g_percent must be 0 for g=${g}`);
      assert.equal(json.details.global_adjust_delta, 0, `B2B delta must be 0 for g=${g}`);
      results.push(json.total_ht);
    } finally {
      // restore inside loop to ensure each iteration cleans up
    }
  }
  await setGlobalAdjust(0);
  // All three B2B totals must be identical
  assert.deepEqual(results, [results[0], results[0], results[0]]);
});

// =========================================================
// 5. FALLBACK — row missing
// =========================================================
test('5. fallback: API returns 0-adjustment when row deleted', async () => {
  // Delete the row to simulate missing config
  await sb.from('system_settings').delete().eq('key', 'global_adjust_percent');
  try {
    const { status, json } = await callApi({
      depart: 'Paris, France', arrivee: 'Lyon, France',
      type: 'Automobile', mode: 'route', pack: 'excellence',
      isPro: false
    });
    assert.equal(status, 200);
    assert.equal(json.details.global_adjust_percent, 0, 'should fall back to 0');
    assert.equal(json.details.global_adjust_delta, 0);
    assert.equal(json.details.packPrice, 149);
  } finally {
    // Re-insert the row
    await sb.from('system_settings')
      .insert({ key: 'global_adjust_percent', value: { percent: 0 } });
  }
});

// =========================================================
// 6. FALLBACK — malformed value
// =========================================================
test('6. fallback: API returns 0-adjustment when value malformed', async () => {
  // Set a malformed value (percent is a string, not a number)
  await sb.from('system_settings')
    .update({ value: { percent: 'not-a-number' } })
    .eq('key', 'global_adjust_percent');
  try {
    const { status, json } = await callApi({
      depart: 'Paris, France', arrivee: 'Lyon, France',
      type: 'Automobile', mode: 'route', pack: 'excellence',
      isPro: false
    });
    assert.equal(status, 200);
    assert.equal(json.details.global_adjust_percent, 0, 'malformed → 0');
    assert.equal(json.details.global_adjust_delta, 0);
  } finally {
    // Restore valid value
    await setGlobalAdjust(0);
  }
});

test('6. fallback: API returns 0-adjustment when percent is null', async () => {
  await sb.from('system_settings')
    .update({ value: { percent: null } })
    .eq('key', 'global_adjust_percent');
  try {
    const { status, json } = await callApi({
      depart: 'Paris, France', arrivee: 'Lyon, France',
      type: 'Automobile', mode: 'route', pack: 'excellence',
      isPro: false
    });
    assert.equal(status, 200);
    assert.equal(json.details.global_adjust_percent, 0);
  } finally {
    await setGlobalAdjust(0);
  }
});

// =========================================================
// 7. SNAPSHOT CONTRACT via API
// =========================================================
test('7. snapshot: API response details include global_adjust_percent and global_adjust_delta', async () => {
  await setGlobalAdjust(10);
  try {
    const { status, json } = await callApi({
      depart: 'Paris, France', arrivee: 'Lyon, France',
      type: 'Automobile', mode: 'route', pack: 'excellence',
      isPro: false
    });
    assert.equal(status, 200);
    assert.ok('global_adjust_percent' in json.details);
    assert.ok('global_adjust_delta' in json.details);
    assert.ok('packPrice' in json.details);
    assert.equal(json.details.packPrice, 149);
    // Verify applied_coeffs includes the global adjustment entry
    const entry = json.details.applied_coeffs.find(c => c.label.includes('Ajustement global'));
    assert.ok(entry, 'applied_coeffs should include global adjustment');
    assert.equal(entry.value, 0.10);
    assert.ok(typeof entry.delta === 'number');
  } finally {
    await setGlobalAdjust(0);
  }
});

// =========================================================
// 8. CLEANUP — restore default state
// =========================================================
test('8. cleanup: restore global_adjust_percent to 0', async () => {
  await setGlobalAdjust(0);
  const data = await getGlobalAdjust();
  assert.equal(data.value.percent, 0);
});
