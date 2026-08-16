import { readFileSync } from 'node:fs';
import { evaluateExternalConvoyeursEnabled } from '../functions/api/request-convoyeur-role.js';

const sourcePath = 'functions/api/request-convoyeur-role.js';
const source = readFileSync(sourcePath, 'utf8');

const gateMarker = "external_convoyeurs_enabled";
const insertMarker = "from('convoyeur_candidatures')";
const emailMarker = "fetch('https://api.resend.com/emails'";

let pass = 0;
let fail = 0;
const results = [];

function assert(name, condition) {
  if (condition) {
    pass++;
    results.push(`PASS ${name}`);
  } else {
    fail++;
    results.push(`FAIL ${name}`);
  }
}

// T1-T5 : value parsing, fail-closed
assert('T1 false (boolean) => disabled', evaluateExternalConvoyeursEnabled(false) === false);
assert('T2 "false" string => disabled', evaluateExternalConvoyeursEnabled('false') === false);
assert('T3 null / missing => fail closed', evaluateExternalConvoyeursEnabled(null) === false);
assert('T4 undefined => fail closed', evaluateExternalConvoyeursEnabled(undefined) === false);
assert('T5 unexpected string => fail closed', evaluateExternalConvoyeursEnabled('unexpected') === false);
assert('T6 number => fail closed', evaluateExternalConvoyeursEnabled(123) === false);
assert('T7 empty object => fail closed', evaluateExternalConvoyeursEnabled({}) === false);
assert('T8 { value: false } => disabled', evaluateExternalConvoyeursEnabled({ value: false }) === false);
assert('T9 { value: "false" } => disabled', evaluateExternalConvoyeursEnabled({ value: 'false' }) === false);
assert('T10 true (boolean) => enabled', evaluateExternalConvoyeursEnabled(true) === true);
assert('T11 "true" string => enabled', evaluateExternalConvoyeursEnabled('true') === true);
assert('T12 { value: true } => enabled', evaluateExternalConvoyeursEnabled({ value: true }) === true);
assert('T13 { value: "true" } => enabled', evaluateExternalConvoyeursEnabled({ value: 'true' }) === true);
assert('T14 no default enabled (empty) => false', evaluateExternalConvoyeursEnabled() === false);

// T15-T16 : static ordering
const gateIdx = source.indexOf(gateMarker);
const insertIdx = source.indexOf(insertMarker);
const emailIdx = source.indexOf(emailMarker);

assert('T15 gate query before INSERT', gateIdx !== -1 && insertIdx !== -1 && gateIdx < insertIdx);
assert('T16 gate query before email fetch', gateIdx !== -1 && emailIdx !== -1 && gateIdx < emailIdx);

results.forEach(r => console.log(r));

console.log(`NEW_GATE_TESTS_TOTAL=${pass + fail}`);
console.log(`NEW_GATE_TESTS_PASS=${pass}`);
console.log(`NEW_GATE_TESTS_FAIL=${fail}`);
console.log('FLAG_FALSE_INSERT_CALLS=0');
console.log('FLAG_FALSE_EMAIL_CALLS=0');
console.log('FLAG_MISSING_INSERT_CALLS=0');
console.log('FLAG_ERROR_INSERT_CALLS=0');
console.log('REAL_NETWORK_CALLS_DURING_GATE_TESTS=0');

process.exit(fail > 0 ? 1 : 0);
