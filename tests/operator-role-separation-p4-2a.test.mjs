import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const dashboard = await readFile(new URL('../dashboard-operator.html', import.meta.url), 'utf8');
const resetHandler = await readFile(new URL('../functions/api/operator-reset-password.js', import.meta.url), 'utf8');

test('operator access is authorized only through the server-side role helper', () => {
  assert.match(dashboard, /sb\.rpc\('is_operator'\)/);
  assert.match(dashboard, /_operatorUser = \{ authUserId: (?:authData|session)\.user\.id \}/);
});

test('operator access no longer depends on a convoyeur profile', () => {
  assert.doesNotMatch(dashboard, /\.from\('convoyeurs'\)/);
  assert.doesNotMatch(dashboard, /Profil exécutant interne non configuré/);
  assert.doesNotMatch(dashboard, /_operatorUser\.id/);
  assert.doesNotMatch(resetHandler, /\.from\('convoyeurs'\)/);
});

test('operator dashboard uses the global mission scope already enforced by RLS', () => {
  assert.match(dashboard, /_myMissions = missions \|\| \[\];/);
  assert.doesNotMatch(dashboard, /\.filter\(m => m\.convoyeur_id === _operatorUser/);
  assert.match(dashboard, /Toutes les missions/);
});

test('driver-only actions are not exposed to the separated operator account', () => {
  assert.doesNotMatch(dashboard, /respondToAssignment\(/);
  assert.doesNotMatch(dashboard, /Démarrer la mission/);
  assert.doesNotMatch(dashboard, /Livrer le véhicule/);
  assert.doesNotMatch(dashboard, /showReportIncidentForm\('\$\{mission\.id\}'\)/);
  assert.doesNotMatch(dashboard, /gps-emitter\.html\?id=\$\{mission\.id\}/);
});

test('operator mission query excludes separated convoyeur-only financial and contact fields', () => {
  const missionSelect = dashboard.match(/\.from\('missions'\)[\s\S]*?\.select\('([^']+)'\)/)?.[1] || '';
  assert.ok(missionSelect, 'mission SELECT projection must be present');
  assert.doesNotMatch(missionSelect, /remuneration_convoyeur/);
  assert.doesNotMatch(missionSelect, /convoyeur_telephone/);
  assert.doesNotMatch(missionSelect, /client_telephone/);
});

test('legacy operator convoyeur identity is cleared instead of persisted', () => {
  assert.match(dashboard, /sessionStorage\.removeItem\('operator_user'\)/);
  assert.doesNotMatch(dashboard, /sessionStorage\.setItem\('operator_user'/);
});
