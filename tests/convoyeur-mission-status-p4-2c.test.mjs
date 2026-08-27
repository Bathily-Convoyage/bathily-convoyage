import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const dashboard = await readFile(new URL('../dashboard-convoyeur.html', import.meta.url), 'utf8');

test('cancelled missions are rendered with the Annulée label', () => {
  assert.match(
    dashboard,
    /'cancelled':\s*\{\s*class:\s*'status-rejected',\s*label:\s*'Annulée',\s*color:\s*'#[0-9a-fA-F]{6}'\s*\}/,
  );
});

test('accepted missions keep their Confirmée label', () => {
  assert.match(
    dashboard,
    /'accepted':\s*\{[^}]*label:\s*'Confirmée'/,
  );
});

test('mission cards resolve their label from the actual mission status', () => {
  assert.match(dashboard, /const si = statusInfo\[m\.status\]/);
  assert.match(dashboard, /\$\{si\.label\}/);
});
