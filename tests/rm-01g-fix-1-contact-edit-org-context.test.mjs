// =========================================================
// RM-01G-FIX-1 — Contact Edit Organization Context Regression
// =========================================================
// Verifies that:
//   A. contact query includes organization_id
//   B. same-organization contact opens edit form
//   C. cross-organization contact is still rejected
//   D. missing organization_id is not silently accepted
//   E. existing RM-01F atomic contact update path remains unchanged
// =========================================================

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const CRM_ADMIN_PATH = 'public/js/crm-admin.js';
const source = readFileSync(CRM_ADMIN_PATH, 'utf8');

function extractFunctionSource(src, fnName, window = 800) {
  const idx = src.indexOf(`function ${fnName}`);
  if (idx === -1) return '';
  const end = src.indexOf('\n  function ', idx + 1);
  return src.slice(idx, end !== -1 ? end : idx + window);
}

test('A: contact query includes organization_id', () => {
  const contactSelectPattern = /from\('organization_contacts'\)\s*\n\s*\.select\('([^']*)'/;
  const match = source.match(contactSelectPattern);
  assert.ok(match, 'organization_contacts select query must exist');
  const selectFields = match[1].split(',');
  assert.ok(
    selectFields.includes('organization_id'),
    `organization_id must be in select: ${match[1]}`
  );
});

test('B: same-organization contact opens edit form', () => {
  const fnSrc = extractFunctionSource(source, 'openEditContactForm', 600);
  assert.ok(fnSrc, 'openEditContactForm must exist');
  assert.ok(fnSrc.includes('_contactMap'), 'must use _contactMap');
  assert.ok(fnSrc.includes('organization_id'), 'must check organization_id');
  assert.ok(fnSrc.includes('String(contact.organization_id'), 'must compare organization_id');
  assert.ok(fnSrc.includes('String(orgId'), 'must compare orgId');
  assert.ok(fnSrc.includes('openCrmModal'), 'must open CRM modal after guard');
});

test('C: cross-organization contact is still rejected', () => {
  const fnSrc = extractFunctionSource(source, 'openEditContactForm', 600);
  assert.ok(fnSrc, 'openEditContactForm must exist');
  assert.ok(fnSrc.includes('!=='), 'must use strict inequality');
  assert.ok(fnSrc.includes('appartient pas'), 'must show cross-org error');
  const guardIdx = fnSrc.indexOf("appartient pas");
  const modalIdx = fnSrc.indexOf('openCrmModal');
  assert.ok(guardIdx > -1, 'cross-org error must exist');
  assert.ok(modalIdx > -1, 'openCrmModal must exist');
  assert.ok(guardIdx < modalIdx, 'guard must come before modal open');
});

test('D: missing organization_id is not silently accepted', () => {
  const fnSrc = extractFunctionSource(source, 'openEditContactForm', 600);
  assert.ok(fnSrc, 'openEditContactForm must exist');
  assert.ok(
    fnSrc.includes("contact.organization_id || ''"),
    'must coerce undefined to empty string (not silently accept)'
  );
  assert.ok(
    fnSrc.includes("orgId || ''"),
    'must coerce orgId to empty string for comparison'
  );
});

test('E: RM-01F atomic contact update path unchanged', () => {
  const fnSrc = extractFunctionSource(source, 'submitEditContact', 1200);
  assert.ok(fnSrc, 'submitEditContact must exist');
  assert.ok(fnSrc.includes('crm_update_contact_atomic'), 'must use atomic RPC');
  assert.ok(fnSrc.includes('organization_contacts'), 'must have direct update path');
  assert.ok(fnSrc.includes('primary_contact'), 'must check primary_contact');
});
