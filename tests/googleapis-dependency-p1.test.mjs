import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { google } from 'googleapis';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('Google APIs dependency is pinned to the reviewed version', () => {
  assert.equal(packageJson.dependencies.googleapis, '176.0.0');
});

test('Google Search Console client remains available after the major upgrade', () => {
  const auth = new google.auth.JWT(
    'test@example.invalid',
    null,
    'not-a-real-private-key',
    ['https://www.googleapis.com/auth/webmasters.readonly'],
  );
  const searchconsole = google.searchconsole({ version: 'v1', auth });

  assert.equal(typeof searchconsole.searchanalytics.query, 'function');
});
