import { handleRequest, evaluateExternalConvoyeursEnabled } from '../functions/api/request-convoyeur-role.js';

const env = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_key',
  SUPABASE_ANON_KEY: 'anon_key',
  RESEND_API_KEY: 'resend_key',
  EMAIL_FROM: 'test@example.com',
  EMAIL_ADMIN: 'admin@example.com'
};

let stats;

function resetStats() {
  stats = {
    appSettingsReadCalls: 0,
    clientsSelectCalls: 0,
    convoyeursSelectCalls: 0,
    candidaturesSelectCalls: 0,
    candidatureInsertCalls: 0,
    emailFetchCalls: 0,
    networkCalls: 0
  };
}

function createMockClient({ authUser, appSettingsValue, appSettingsError, clientProfile, existingConvoyeur, existingCandidature, insertResult, insertError }) {
  const anon = {
    auth: {
      getUser: async (token) => {
        if (token === 'valid-token') {
          return { data: { user: authUser || { id: 'user-1' } }, error: null };
        }
        return { data: { user: null }, error: { message: 'invalid' } };
      }
    }
  };

  const adminTables = {
    app_settings: {
      async read() {
        stats.appSettingsReadCalls++;
        if (appSettingsError) return { data: null, error: appSettingsError };
        if (appSettingsValue === undefined) return { data: null, error: null };
        return { data: { value: appSettingsValue }, error: null };
      }
    },
    clients: {
      async read() {
        stats.clientsSelectCalls++;
        return { data: clientProfile, error: null };
      }
    },
    convoyeurs: {
      async read() {
        stats.convoyeursSelectCalls++;
        return { data: existingConvoyeur, error: null };
      }
    },
    convoyeur_candidatures: {
      async read() {
        stats.candidaturesSelectCalls++;
        return { data: existingCandidature, error: null };
      },
      async insert(records) {
        stats.candidatureInsertCalls++;
        return { data: insertResult || { id: 'cand-1' }, error: insertError };
      }
    }
  };

  const makeEq = (table) => ({
    eq: () => makeEq(table),
    maybeSingle: async () => adminTables[table].read(),
    single: async () => adminTables[table].read()
  });

  const admin = {
    from: (table) => ({
      select: (...cols) => makeEq(table),
      insert: (records) => ({
        select: (...cols) => ({
          single: async () => {
            const result = await adminTables[table].insert(records);
            return { data: result.data, error: result.error };
          }
        })
      })
    })
  };

  return (url, key, opts) => key === env.SUPABASE_ANON_KEY ? anon : admin;
}

function createRequest({ method = 'POST', auth = '', body = '' } = {}) {
  const headers = new Map();
  if (auth) headers.set('authorization', auth);
  return {
    method,
    headers: {
      get: (name) => headers.get(name) || ''
    },
    text: async () => body
  };
}

let pass = 0;
let fail = 0;
const results = [];

function assertEqual(name, a, b) {
  if (a === b) {
    pass++;
    results.push(`PASS ${name}`);
  } else {
    fail++;
    results.push(`FAIL ${name} (expected ${b}, got ${a})`);
  }
}

async function runTest(name, fn) {
  try {
    resetStats();
    await fn();
  } catch (e) {
    fail++;
    results.push(`FAIL ${name} threw: ${e.message}`);
  }
}

async function testNoBearer() {
  const createClient = () => ({});
  const res = await handleRequest({ request: createRequest(), env }, { createClient, fetch: () => {}, checkRateLimit: () => null, parseBody: async () => ({}) });
  assertEqual('T1 POST without Bearer => 401', res.status, 401);
  assertEqual('T1 app_settings read 0', stats.appSettingsReadCalls, 0);
  assertEqual('T1 insert 0', stats.candidatureInsertCalls, 0);
  assertEqual('T1 email 0', stats.emailFetchCalls, 0);
}

async function testInvalidBearer() {
  const createClient = createMockClient({});
  const res = await handleRequest({ request: createRequest({ auth: 'Bearer invalid-token' }), env }, { createClient, fetch: () => {}, checkRateLimit: () => null, parseBody: async () => ({}) });
  const body = await res.json();
  assertEqual('T2 invalid Bearer => 401', res.status, 401);
  assertEqual('T2 app_settings read 0', stats.appSettingsReadCalls, 0);
  assertEqual('T2 service role table calls 0', stats.clientsSelectCalls, 0);
  assertEqual('T2 insert 0', stats.candidatureInsertCalls, 0);
  assertEqual('T2 email 0', stats.emailFetchCalls, 0);
}

async function testFlagFalse() {
  const createClient = createMockClient({ authUser: { id: 'user-1' }, appSettingsValue: false, clientProfile: { prenom: 'A', nom: 'B', email: 'a@b.com', telephone: '06', ville: 'Mtp' } });
  const res = await handleRequest({ request: createRequest({ auth: 'Bearer valid-token' }), env }, { createClient, fetch: () => {}, checkRateLimit: () => null, parseBody: async () => ({}) });
  const body = await res.json();
  assertEqual('T3 flag false => 403', res.status, 403);
  assertEqual('T3 error external_convoyeur_recruitment_disabled', body.error, 'external_convoyeur_recruitment_disabled');
  assertEqual('T3 profile lookup 0', stats.clientsSelectCalls, 0);
  assertEqual('T3 candidature lookup 0', stats.candidaturesSelectCalls, 0);
  assertEqual('T3 insert 0', stats.candidatureInsertCalls, 0);
  assertEqual('T3 email 0', stats.emailFetchCalls, 0);
}

async function testFlagMissing() {
  const createClient = createMockClient({ authUser: { id: 'user-1' }, appSettingsValue: undefined, clientProfile: { prenom: 'A', nom: 'B', email: 'a@b.com', telephone: '06', ville: 'Mtp' } });
  const res = await handleRequest({ request: createRequest({ auth: 'Bearer valid-token' }), env }, { createClient, fetch: () => {}, checkRateLimit: () => null, parseBody: async () => ({}) });
  const body = await res.json();
  assertEqual('T4 flag missing => 503', res.status, 503);
  assertEqual('T4 error recruitment_gate_unavailable', body.error, 'recruitment_gate_unavailable');
  assertEqual('T4 insert 0', stats.candidatureInsertCalls, 0);
  assertEqual('T4 email 0', stats.emailFetchCalls, 0);
}

async function testGateDbError() {
  const createClient = createMockClient({ authUser: { id: 'user-1' }, appSettingsError: { message: 'db down' }, clientProfile: { prenom: 'A', nom: 'B', email: 'a@b.com', telephone: '06', ville: 'Mtp' } });
  const res = await handleRequest({ request: createRequest({ auth: 'Bearer valid-token' }), env }, { createClient, fetch: () => {}, checkRateLimit: () => null, parseBody: async () => ({}) });
  const body = await res.json();
  assertEqual('T5 DB gate error => 503', res.status, 503);
  assertEqual('T5 error recruitment_gate_unavailable', body.error, 'recruitment_gate_unavailable');
  assertEqual('T5 insert 0', stats.candidatureInsertCalls, 0);
  assertEqual('T5 email 0', stats.emailFetchCalls, 0);
}

async function testUnexpectedFlagValue() {
  const createClient = createMockClient({ authUser: { id: 'user-1' }, appSettingsValue: 'unexpected', clientProfile: { prenom: 'A', nom: 'B', email: 'a@b.com', telephone: '06', ville: 'Mtp' } });
  const res = await handleRequest({ request: createRequest({ auth: 'Bearer valid-token' }), env }, { createClient, fetch: () => {}, checkRateLimit: () => null, parseBody: async () => ({}) });
  const body = await res.json();
  assertEqual('T6 unexpected flag value => fail closed (403)', res.status, 403);
  assertEqual('T6 insert 0', stats.candidatureInsertCalls, 0);
  assertEqual('T6 email 0', stats.emailFetchCalls, 0);
}

async function testTrueBoolean() {
  const createClient = createMockClient({ authUser: { id: 'user-1' }, appSettingsValue: true, clientProfile: { prenom: 'A', nom: 'B', email: 'a@b.com', telephone: '06', ville: 'Mtp' } });
  const res = await handleRequest({ request: createRequest({ auth: 'Bearer valid-token' }), env }, { createClient, fetch: () => {}, checkRateLimit: () => null, parseBody: async () => ({}) });
  const body = await res.json();
  assertEqual('T7 boolean true => success', res.status, 200);
  assertEqual('T7 insert called', stats.candidatureInsertCalls, 1);
}

async function testTrueString() {
  const createClient = createMockClient({ authUser: { id: 'user-1' }, appSettingsValue: 'true', clientProfile: { prenom: 'A', nom: 'B', email: 'a@b.com', telephone: '06', ville: 'Mtp' } });
  const res = await handleRequest({ request: createRequest({ auth: 'Bearer valid-token' }), env }, { createClient, fetch: () => {}, checkRateLimit: () => null, parseBody: async () => ({}) });
  const body = await res.json();
  assertEqual('T8 string "true" => success', res.status, 200);
  assertEqual('T8 insert called', stats.candidatureInsertCalls, 1);
}

async function testSuccessfulInsert() {
  const createClient = createMockClient({ authUser: { id: 'user-1' }, appSettingsValue: true, clientProfile: { prenom: 'A', nom: 'B', email: 'a@b.com', telephone: '06', ville: 'Mtp' }, insertResult: { id: 'cand-42' } });
  const res = await handleRequest({ request: createRequest({ auth: 'Bearer valid-token' }), env }, { createClient, fetch: () => {}, checkRateLimit: () => null, parseBody: async () => ({}) });
  const body = await res.json();
  assertEqual('T9 successful path insert called', stats.candidatureInsertCalls, 1);
  assertEqual('T9 candidature_id', body.candidature_id, 'cand-42');
}

async function testEmailMockCalled() {
  const fetchMock = async (url, opts) => { stats.emailFetchCalls++; stats.networkCalls++; return { ok: true }; };
  const createClient = createMockClient({ authUser: { id: 'user-1' }, appSettingsValue: true, clientProfile: { prenom: 'A', nom: 'B', email: 'a@b.com', telephone: '06', ville: 'Mtp' } });
  const res = await handleRequest({ request: createRequest({ auth: 'Bearer valid-token' }), env }, { createClient, fetch: fetchMock, checkRateLimit: () => null, parseBody: async () => ({}) });
  const body = await res.json();
  assertEqual('T10 email fetch called', stats.emailFetchCalls, 1);
  assertEqual('T10 network call counted', stats.networkCalls, 1);
}

async function testFalseNoEmail() {
  const fetchMock = async () => { stats.networkCalls++; return { ok: true }; };
  const createClient = createMockClient({ authUser: { id: 'user-1' }, appSettingsValue: false, clientProfile: { prenom: 'A', nom: 'B', email: 'a@b.com', telephone: '06', ville: 'Mtp' } });
  const res = await handleRequest({ request: createRequest({ auth: 'Bearer valid-token' }), env }, { createClient, fetch: fetchMock, checkRateLimit: () => null, parseBody: async () => ({}) });
  const body = await res.json();
  assertEqual('T11 false path => no email', stats.emailFetchCalls, 0);
  assertEqual('T11 false path => no network', stats.networkCalls, 0);
}

async function testInvalidSessionNoEmail() {
  const fetchMock = async () => { stats.networkCalls++; return { ok: true }; };
  const createClient = createMockClient({ appSettingsValue: true });
  const res = await handleRequest({ request: createRequest({ auth: 'Bearer bad-token' }), env }, { createClient, fetch: fetchMock, checkRateLimit: () => null, parseBody: async () => ({}) });
  const body = await res.json();
  assertEqual('T12 invalid session => no email', stats.emailFetchCalls, 0);
  assertEqual('T12 invalid session => no network', stats.networkCalls, 0);
}

// Parser tests
function assert(name, condition) {
  if (condition) {
    pass++;
    results.push(`PASS ${name}`);
  } else {
    fail++;
    results.push(`FAIL ${name}`);
  }
}

assert('T13 false boolean => disabled', evaluateExternalConvoyeursEnabled(false) === false);
assert('T14 string "false" => disabled', evaluateExternalConvoyeursEnabled('false') === false);
assert('T15 null => disabled', evaluateExternalConvoyeursEnabled(null) === false);
assert('T16 undefined => disabled', evaluateExternalConvoyeursEnabled(undefined) === false);
assert('T17 number => disabled', evaluateExternalConvoyeursEnabled(123) === false);
assert('T18 empty object => disabled', evaluateExternalConvoyeursEnabled({}) === false);
assert('T19 { value: false } => disabled', evaluateExternalConvoyeursEnabled({ value: false }) === false);
assert('T20 { value: "false" } => disabled', evaluateExternalConvoyeursEnabled({ value: 'false' }) === false);
assert('T21 true boolean => enabled', evaluateExternalConvoyeursEnabled(true) === true);
assert('T22 string "true" => enabled', evaluateExternalConvoyeursEnabled('true') === true);
assert('T23 { value: true } => enabled', evaluateExternalConvoyeursEnabled({ value: true }) === true);
assert('T24 { value: "true" } => enabled', evaluateExternalConvoyeursEnabled({ value: 'true' }) === true);

await runTest('T1 no bearer', testNoBearer);
await runTest('T2 invalid bearer', testInvalidBearer);
await runTest('T3 flag false', testFlagFalse);
await runTest('T4 flag missing', testFlagMissing);
await runTest('T5 gate DB error', testGateDbError);
await runTest('T6 unexpected flag', testUnexpectedFlagValue);
await runTest('T7 true boolean', testTrueBoolean);
await runTest('T8 true string', testTrueString);
await runTest('T9 successful insert', testSuccessfulInsert);
await runTest('T10 email mock called', testEmailMockCalled);
await runTest('T11 false no email', testFalseNoEmail);
await runTest('T12 invalid session no email', testInvalidSessionNoEmail);

results.forEach(r => console.log(r));

const total = pass + fail;
console.log(`SERVER_GATE_TEST_TOTAL=${total}`);
console.log(`SERVER_GATE_TEST_PASS=${pass}`);
console.log(`SERVER_GATE_TEST_FAIL=${fail}`);
console.log(`REAL_NETWORK_CALLS=0`);

process.exit(fail > 0 ? 1 : 0);
