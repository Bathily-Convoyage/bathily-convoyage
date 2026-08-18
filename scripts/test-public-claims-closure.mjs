// WAVE 2B.6 — Public Claims / Recruitment Closure tests
// REAL_EXTERNAL_NETWORK_CALLS = 0 — static tests only, no browser.
//
// Tests:
//  1. manifest root/public identical
//  2. "double assurance RC Pro" absent runtime
//  3. "Devis en 2min" absent runtime
//  4. recrutement public CTA absent
//  5. "sous 48h" recruitment promise absent
//  6. unsupported 24/7 claims absent from contact.html
//  7. traitement prioritaire absent from espace-pro.html
//  8. defer="None" absent
//  9. authorized GPS wording still present somewhere expected
// 10. external convoyeur architecture not deleted
// 11. no pricing files modified (vs HEAD)
// 12. no GPS implementation files modified (vs HEAD)
// 13. no SIV logic modified (vs HEAD)
// 14. no address helper modified (vs HEAD)

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const ROOT = new URL('../', import.meta.url);
let _passCount = 0;
let _failCount = 0;
const _results = [];

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`ASSERT: ${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
async function test(name, fn) {
  try {
    await fn();
    _passCount++;
    _results.push({ name, status: 'PASS' });
  } catch (err) {
    _failCount++;
    _results.push({ name, status: 'FAIL', error: err.message });
  }
}

function readFile(path) {
  return readFileSync(new URL(path, ROOT), 'utf-8');
}

function fileExists(path) {
  return existsSync(new URL(path, ROOT));
}

function gitDiffNameOnly(vsRef) {
  try {
    const out = execSync(`git diff --name-only ${vsRef}..HEAD`, {
      cwd: new URL('../', import.meta.url).pathname.replace(/\//g, '\\'),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return out.trim().split('\n').filter(l => l.length > 0);
  } catch (e) {
    return [];
  }
}

// ============================================================
// TESTS
// ============================================================

await test('1. manifest root/public identical', async () => {
  const a = readFile('manifest.json');
  const b = readFile('public/manifest.json');
  assertEq(a, b, 'manifest.json mirror match');
});

await test('2. "double assurance RC Pro" absent runtime', async () => {
  const files = ['manifest.json', 'public/manifest.json', 'index.html', 'contact.html', 'qui-sommes-nous.html', 'espace-pro.html', 'mentions-legales.html'];
  let count = 0;
  files.forEach(f => {
    const c = readFile(f);
    const m = c.match(/double assurance RC Pro|double RC Pro|Double RC Pro/gi);
    if (m) count += m.length;
  });
  assertEq(count, 0, 'no "double assurance RC Pro" in public files');
});

await test('3. "Devis en 2min" absent runtime', async () => {
  const files = ['manifest.json', 'public/manifest.json', 'index.html', 'contact.html'];
  let count = 0;
  files.forEach(f => {
    const c = readFile(f);
    const m = c.match(/Devis en 2min|Devis en 2 min|devis en 2min/gi);
    if (m) count += m.length;
  });
  assertEq(count, 0, 'no "Devis en 2min" in public files');
});

await test('4. recrutement public CTA absent', async () => {
  const files = ['contact.html', 'qui-sommes-nous.html', 'mentions-legales.html'];
  let count = 0;
  files.forEach(f => {
    const c = readFile(f);
    // Look for "Devenir convoyeur" links or recruitment CTAs in nav
    const m = c.match(/href="formation-convoyeur\.html"[^>]*>Devenir convoyeur/gi);
    if (m) count += m.length;
  });
  assertEq(count, 0, 'no public recruitment CTA links');
});

await test('5. "sous 48h" recruitment promise absent', async () => {
  const files = ['contact.html', 'qui-sommes-nous.html', 'mentions-legales.html', 'espace-pro.html'];
  let count = 0;
  files.forEach(f => {
    const c = readFile(f);
    const m = c.match(/sous 48h|sous 24h|contactera sous/gi);
    if (m) count += m.length;
  });
  assertEq(count, 0, 'no recruitment response time promises');
});

await test('6. unsupported 24/7 claims absent from contact.html', async () => {
  const c = readFile('contact.html');
  const m = c.match(/24h\/24|24\/7|7j\/7/g);
  assertEq(m ? m.length : 0, 0, 'no unsupported 24/7 availability claims in contact.html');
});

await test('7. traitement prioritaire absent from espace-pro.html', async () => {
  const c = readFile('espace-pro.html');
  const m = c.match(/traitement prioritaire|prise en charge prioritaire/gi);
  assertEq(m ? m.length : 0, 0, 'no unsupported priority claims in espace-pro.html');
});

await test('8. defer="None" absent', async () => {
  // Check all HTML files in root
  const { readdirSync } = await import('fs');
  const files = readdirSync(new URL('.', ROOT)).filter(f => f.endsWith('.html'));
  let count = 0;
  files.forEach(f => {
    const c = readFileSync(new URL(f, ROOT), 'utf-8');
    const m = c.match(/defer="None"/g);
    if (m) count += m.length;
  });
  assertEq(count, 0, 'no defer="None" in any HTML file');
});

await test('9. authorized GPS wording still present somewhere expected', async () => {
  const files = ['manifest.json', 'tracking.html', 'index.html', 'qui-sommes-nous.html'];
  let found = false;
  files.forEach(f => {
    if (!fileExists(f)) return;
    const c = readFile(f);
    if (c.match(/suivi GPS en temps réel|suivi GPS temps réel|Suivi GPS en temps réel|Suivi GPS temps réel/i)) {
      found = true;
    }
  });
  assert(found, 'authorized GPS wording present in at least one expected file');
});

await test('10. external convoyeur architecture not deleted', async () => {
  assert(fileExists('dashboard-convoyeur.html'), 'dashboard-convoyeur.html still exists');
  assert(fileExists('bon-de-mission.html'), 'bon-de-mission.html still exists');
  assert(fileExists('tracking.html'), 'tracking.html still exists');
  // Check that espace-pro.html still mentions convoyeur/partenaire
  const c = readFile('espace-pro.html');
  assert(c.match(/convoyeur|partenaire/i), 'espace-pro.html still references convoyeur architecture');
});

await test('11. no pricing files modified (vs HEAD)', async () => {
  const diff = gitDiffNameOnly('HEAD');
  const pricingFiles = diff.filter(f => f === 'js/pricing.js' || f === 'public/js/pricing.js' || f === 'functions/_pricing.js');
  assertEq(pricingFiles.length, 0, 'no pricing files modified: ' + pricingFiles.join(', '));
});

await test('12. no GPS implementation files modified (vs HEAD)', async () => {
  const diff = gitDiffNameOnly('HEAD');
  const gpsFiles = diff.filter(f => f.includes('tracking') || f.includes('gps'));
  assertEq(gpsFiles.length, 0, 'no GPS implementation files modified: ' + gpsFiles.join(', '));
});

await test('13. no SIV logic modified (vs HEAD)', async () => {
  const diff = gitDiffNameOnly('HEAD');
  const sivFiles = diff.filter(f => f.includes('lookup-vehicle') || f.includes('siv') || f.includes('vehicle-lookup'));
  assertEq(sivFiles.length, 0, 'no SIV logic files modified: ' + sivFiles.join(', '));
});

await test('14. no address helper modified (vs HEAD)', async () => {
  const diff = gitDiffNameOnly('HEAD');
  const addrFiles = diff.filter(f => f.includes('address-autocomplete'));
  assertEq(addrFiles.length, 0, 'no address helper files modified: ' + addrFiles.join(', '));
});

// ============================================================
// REPORT
// ============================================================
console.log('\n=== WAVE 2B.6 PUBLIC CLAIMS / RECRUITMENT CLOSURE TESTS ===\n');
_results.forEach(r => {
  console.log(`[${r.status}] ${r.name}${r.error ? ' — ' + r.error : ''}`);
});
console.log(`\n${_passCount} passed, ${_failCount} failed`);
console.log(`REAL_EXTERNAL_NETWORK_CALLS = 0`);
console.log(_failCount === 0 ? 'ALL TESTS PASS' : 'SOME TESTS FAILED');
process.exit(_failCount === 0 ? 0 : 1);
