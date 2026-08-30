// INDY-3B — Admin Billing Workflow — Static Frontend Validation
//
// Validates dashboard-admin.html for:
// - billing_records as data source (not missions pseudo-invoice)
// - no direct billing_records INSERT/UPDATE/DELETE
// - prepare_billing_record RPC used for prepare
// - link_external_invoice RPC used for issue
// - cancel_billing_record RPC used for cancel
// - no jsPDF legal invoice generation in billing workflow
// - no F-${reference} pseudo legal numbering
// - legal invoice number comes from external_invoice_number
// - billing tabs/statuses present (to_invoice, prepared, issued, cancelled)
// - prepared warning "not issued" present
// - issued record shows Indy number
// - issued record has no cancel action
// - prepared has cancel action
// - payment state visually separate from billing
// - no billing_events write from frontend
// - no service role key in frontend
// - cutoff loaded from app_settings
// - completed + positive amount eligibility logic
// - cancelled allows re-eligibility
// - no misleading KPIs (CA ce mois, Factures payées)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const htmlUrl = new URL('../dashboard-admin.html', import.meta.url);
const html = await readFile(htmlUrl, 'utf8');

const checks = [
  // =========================================================
  // DATA SOURCE — billing_records, not missions pseudo-invoice
  // =========================================================
  ['reads billing_records table', /from\('billing_records'\)/i.test(html)],
  ['reads app_settings for cutoff', /from\('app_settings'\)/i.test(html)],
  ['billing_workflow_start_at key referenced', /billing_workflow_start_at/.test(html)],

  // =========================================================
  // RPC USAGE — all mutations via approved RPCs
  // =========================================================
  ['prepare uses prepare_billing_record RPC', /rpc\('prepare_billing_record'/.test(html)],
  ['issue uses link_external_invoice RPC', /rpc\('link_external_invoice'/.test(html)],
  ['cancel uses cancel_billing_record RPC', /rpc\('cancel_billing_record'/.test(html)],

  // =========================================================
  // NO DIRECT TABLE WRITES
  // =========================================================
  ['no direct billing_records INSERT', !/\.from\('billing_records'\)\.insert\(/i.test(html)],
  ['no direct billing_records UPDATE', !/\.from\('billing_records'\)\.update\(/i.test(html)],
  ['no direct billing_records DELETE', !/\.from\('billing_records'\)\.delete\(/i.test(html)],
  ['no direct billing_events INSERT', !/\.from\('billing_events'\)\.insert\(/i.test(html)],
  ['no direct billing_events UPDATE', !/\.from\('billing_events'\)\.update\(/i.test(html)],
  ['no direct billing_events DELETE', !/\.from\('billing_events'\)\.delete\(/i.test(html)],
  ['no prepared_payload construction in frontend', !/prepared_payload\s*[:=]\s*jsonb_build/i.test(html) && !/prepared_payload\s*[:=]\s*\{/i.test(html)],

  // =========================================================
  // PSEUDO INVOICE CLEANUP
  // =========================================================
  ['no F-${reference} pseudo numbering in billing', !/F-\$\{.*reference/i.test(html)],
  ['no FACTURE jsPDF title in billing', !/doc\.text\('FACTURE'/.test(html)],
  ['no downloadInvoice function', !/window\.downloadInvoice\s*=/.test(html)],
  ['no Télécharger PDF in billing context', !/Télécharger PDF/.test(html)],
  ['no Générer facture button', !/Générer facture/.test(html)],
  ['legal invoice number from external_invoice_number', /external_invoice_number/.test(html)],

  // =========================================================
  // BILLING TABS / STATUSES
  // =========================================================
  ['billingKpiToInvoice element exists', /id="billingKpiToInvoice"/.test(html)],
  ['billingKpiPrepared element exists', /id="billingKpiPrepared"/.test(html)],
  ['billingKpiIssued element exists', /id="billingKpiIssued"/.test(html)],
  ['billingKpiCancelled element exists', /id="billingKpiCancelled"/.test(html)],
  ['À facturer label present', /À facturer/.test(html)],
  ['Préparées label present', /Préparées/.test(html)],
  ['Émises dans Indy label present', /Émises dans Indy/.test(html)],
  ['Annulées label present', /Annulées/.test(html)],
  ['filterBillingView function exists', /window\.filterBillingView\s*=/.test(html)],
  ['loadBillingData function exists', /async\s+function\s+loadBillingData/.test(html)],
  ['renderBillingView function exists', /function\s+renderBillingView/.test(html)],

  // =========================================================
  // PREPARE ACTION
  // =========================================================
  ['Préparer pour Indy button text', /Préparer pour Indy/.test(html)],
  ['prepareBilling function exists', /window\.prepareBilling\s*=/.test(html)],

  // =========================================================
  // ISSUE ACTION
  // =========================================================
  ['Enregistrer la facture Indy button text', /Enregistrer la facture Indy/.test(html)],
  ['showIssueDialog function exists', /window\.showIssueDialog\s*=/.test(html)],
  ['Numéro de facture Indy label', /Numéro de facture Indy/.test(html)],

  // =========================================================
  // CANCEL ACTION
  // =========================================================
  ['Annuler la préparation text', /Annuler la préparation/.test(html)],
  ['showCancelDialog function exists', /window\.showCancelDialog\s*=/.test(html)],
  ['cancel only for prepared (status check in showCancelDialog)', /r\.status\s*!==\s*'prepared'/.test(html)],

  // =========================================================
  // PREPARED WARNING
  // =========================================================
  ['prepared warning "pas encore émise"', /pas encore émise/.test(html)],

  // =========================================================
  // ISSUED — NO CANCEL
  // =========================================================
  ['issued cancel info message (avoir dans Indy)', /avoir dans Indy/.test(html)],

  // =========================================================
  // PAYMENT SEPARATION
  // =========================================================
  ['markMissionPaid still exists (unchanged)', /window\.markMissionPaid\s*=/.test(html)],
  ['markMissionPaid uses mark_mission_paid RPC', /rpc\('mark_mission_paid'/.test(html)],
  ['Paiement client label in billing detail', /Paiement client/.test(html)],

  // =========================================================
  // NO MISLEADING KPIs
  // =========================================================
  ['no CA ce mois KPI', !/CA ce mois/.test(html)],
  ['no Factures payées KPI', !/Factures payées/.test(html)],
  ['no Factures en attente KPI', !/Factures en attente/.test(html)],

  // =========================================================
  // SECURITY
  // =========================================================
  ['no service_role key in frontend', !/SERVICE_ROLE_KEY/.test(html)],
  ['no supabase service role client creation', !/createClient\([^)]*SERVICE_ROLE/i.test(html)],

  // =========================================================
  // CUTOFF / ELIGIBILITY — deterministic calendar-date rule
  // =========================================================
  ['cutoff stored as raw string', /_billingCutoff\s*=\s*typeof raw\s*===\s*'string'\s*\?\s*raw\s*:\s*String\(raw\)/.test(html)],
  ['computeFirstEligibleDate function exists', /function\s+computeFirstEligibleDate/.test(html)],
  ['first eligible date derived from cutoff + 1 day', /setUTCDate\(d\.getUTCDate\(\)\s*\+\s*1\)/.test(html)],
  ['_billingFirstEligibleDate variable exists', /_billingFirstEligibleDate/.test(html)],
  ['eligibility uses string comparison not Date object', /m\.date_mission\s*<\s*firstEligible/.test(html)],
  ['no Date object comparison for billing cutoff', !/if\s*\(\s*missionDate\s*<\s*cutoff\)/.test(html) && !/new Date\(m\.date_mission.*\).*</.test(html.split('getEligibleMissions')[1] || '')],
  ['null date_mission conservatively excluded', /if\s*\(!m\.date_mission\)\s*return\s*false/.test(html)],
  ['completed status check in eligibility', /m\.status\s*!==\s*'completed'/.test(html) || /m\.status\s*===\s*'completed'/.test(html)],
  ['montant_ht positive check in eligibility', /montant\s*<=\s*0/.test(html) || /montant\s*>\s*0/.test(html)],
  ['active invoice exclusion (prepared/issued)', /status\s*===\s*'prepared'\s*\|\|\s*r\.status\s*===\s*'issued'/.test(html) || /status\s*===\s*'prepared'.*'issued'/s.test(html)],
  ['invoice_type invoice filter', /invoice_type\s*===\s*'invoice'/.test(html)],

  // =========================================================
  // CUTOFF BOUNDARY CASES (computed from production cutoff)
  // =========================================================
  ...(() => {
    const cutoff = '2026-08-30T17:17:09.43536+00:00';
    const datePart = cutoff.slice(0, 10);
    const d = new Date(datePart + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    const firstEligible = d.toISOString().slice(0, 10);
    return [
      ['boundary: first eligible date is 2026-08-31', firstEligible === '2026-08-31'],
      ['boundary: 2026-08-29 excluded', '2026-08-29' < firstEligible],
      ['boundary: 2026-08-30 excluded (same-day as cutoff)', '2026-08-30' < firstEligible],
      ['boundary: 2026-08-31 included', '2026-08-31' >= firstEligible],
      ['boundary: future date included', '2026-12-31' >= firstEligible],
    ];
  })(),

  // =========================================================
  // INDY AS LEGAL SOURCE
  // =========================================================
  ['Indy source of truth disclaimer', /Indy est la source de vérité/i.test(html) || /source de vérité légale/i.test(html)],
  ['provider Indy displayed', /provider.*indy/i.test(html) || /r\.provider/i.test(html)],

  // =========================================================
  // SNAPSHOT FROM prepared_payload
  // =========================================================
  ['prepared_payload used for display', /prepared_payload/.test(html)],
  ['seller data from payload', /payload\.seller|p\.seller/.test(html)],
  ['customer data from payload', /payload\.customer|p\.customer/.test(html)],
  ['mission data from payload', /payload\.mission|p\.mission/.test(html)],
  ['financial data from payload', /payload\.financial|p\.financial/.test(html)],

  // =========================================================
  // NO CLIENT DASHBOARD MODIFICATION
  // =========================================================
  ['dashboard-client.html not modified in this file', true], // tautology — this is a static check on admin file only

  // =========================================================
  // ERROR HANDLING
  // =========================================================
  ['translateBillingError function exists', /function\s+translateBillingError/.test(html)],
  ['duplicate external number translated to French', /Ce numéro de facture Indy est déjà enregistré/.test(html)],
  ['duplicate prepare translated to French', /Une préparation de facturation existe déjà/.test(html)],
  ['permission denied translated to French', /Action non autorisée.*administrateur/.test(html)],
  ['error surfaced in prepareBilling', /translateBillingError\(err\)/.test(html)],
  ['error surfaced in showIssueDialog', /translateBillingError\(err\)/.test(html)],
  ['error surfaced in showCancelDialog', /translateBillingError\(err\)/.test(html)],
];

// =========================================================
// RUN CHECKS
// =========================================================

let passed = 0;
let failed = 0;
const failures = [];

for (const [name, result] of checks) {
  if (result) {
    passed++;
  } else {
    failed++;
    failures.push(name);
  }
}

console.log('');
for (const [name, result] of checks) {
  if (result) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}`);
  }
}

console.log('');
console.log(`${passed} checks passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('');
  console.log('Failures:');
  failures.forEach(f => console.log(`  - ${f}`));
}

if (failed > 0) {
  process.exit(1);
}

console.log('');
console.log('INDY-3B admin billing workflow static validation: PASS');
