// =========================================================
// RM-01B1 — Build Asset Reference Verification
// =========================================================
// Verifies that every local <script src="js/..."> reference in
// HTML files deployed by the Vite build resolves to an actual
// file in public/js/ (the Vite publicDir source that is copied
// to dist/js/ during build).
//
// If dist/ exists (build already ran), also verifies the asset
// exists in dist/js/.
//
// This catches the RM01A-001 regression: dashboard-admin.html
// references js/crm-admin.js but the file was never placed in
// public/js/, so the production build 404'd the script.
//
// Run: node tests/rm-01b1-build-asset-verification.test.mjs
// =========================================================

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

let pass = 0;
function ok(msg) { pass++; console.log('  \u2713 ' + msg); }

// HTML files that Vite builds as entry points (from vite.config.js).
// We scan all HTML files in the repo root for generality.
const htmlFiles = fs.readdirSync(projectRoot)
  .filter(f => f.endsWith('.html'))
  .map(f => path.join(projectRoot, f));

const publicJsDir = path.join(projectRoot, 'public', 'js');
const distJsDir = path.join(projectRoot, 'dist', 'js');
const distExists = fs.existsSync(path.join(projectRoot, 'dist'));

// Regex: <script src="js/..."> (local relative paths only, no CDN/absolute)
const scriptRefRegex = /<script\s+src="(js\/[^"]+)"><\/script>/g;

const allRefs = [];
for (const htmlFile of htmlFiles) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  let match;
  while ((match = scriptRefRegex.exec(html)) !== null) {
    allRefs.push({ htmlFile: path.basename(htmlFile), asset: match[1] });
  }
}

console.log('\n=== RM-01B1 Build Asset Reference Verification ===\n');

assert.ok(allRefs.length > 0, 'Found at least one js/ script reference');
ok('Found ' + allRefs.length + ' local js/ script references across ' + new Set(allRefs.map(r => r.htmlFile)).size + ' HTML file(s)');

// Verify each referenced asset exists in public/js/
const missingFromPublic = [];
for (const ref of allRefs) {
  const publicPath = path.join(projectRoot, 'public', ref.asset);
  if (!fs.existsSync(publicPath)) {
    missingFromPublic.push(ref);
  }
}

assert.strictEqual(missingFromPublic.length, 0,
  'All js/ script references exist in public/js/. Missing: ' +
  missingFromPublic.map(r => r.htmlFile + ' -> ' + r.asset).join(', '));
ok('All ' + allRefs.length + ' js/ script references exist in public/js/');

// Specific regression check: dashboard-admin.html -> js/crm-admin.js
const crmRef = allRefs.find(r => r.htmlFile === 'dashboard-admin.html' && r.asset === 'js/crm-admin.js');
assert.ok(crmRef, 'dashboard-admin.html references js/crm-admin.js');
ok('dashboard-admin.html references js/crm-admin.js');

const crmPublicPath = path.join(publicJsDir, 'crm-admin.js');
assert.ok(fs.existsSync(crmPublicPath), 'public/js/crm-admin.js exists');
ok('public/js/crm-admin.js exists');

// Anti-duplicate: ensure no stale root js/crm-admin.js can become
// authoritative again. public/js/crm-admin.js is the single source.
const staleRootCopy = path.join(projectRoot, 'js', 'crm-admin.js');
assert.ok(!fs.existsSync(staleRootCopy),
  'No stale duplicate at js/crm-admin.js — public/js/crm-admin.js is the single source');
ok('No stale duplicate at js/crm-admin.js (single source of truth)');

// If dist/ exists, verify the built output contains the assets too
if (distExists) {
  const missingFromDist = [];
  for (const ref of allRefs) {
    const distPath = path.join(projectRoot, 'dist', ref.asset);
    if (!fs.existsSync(distPath)) {
      missingFromDist.push(ref);
    }
  }

  assert.strictEqual(missingFromDist.length, 0,
    'All js/ script references exist in dist/js/. Missing: ' +
    missingFromDist.map(r => r.htmlFile + ' -> ' + r.asset).join(', '));
  ok('All ' + allRefs.length + ' js/ script references exist in dist/js/');

  const crmDistPath = path.join(distJsDir, 'crm-admin.js');
  assert.ok(fs.existsSync(crmDistPath), 'dist/js/crm-admin.js exists');
  ok('dist/js/crm-admin.js exists');
} else {
  console.log('  (skipped dist/ check — no build output found)');
}

// =========================================================
// SUMMARY
// =========================================================
console.log('\n=== RM-01B1 Build Asset Verification Summary ===');
console.log('Assertions passed: ' + pass);
console.log('Result: PASS\n');
