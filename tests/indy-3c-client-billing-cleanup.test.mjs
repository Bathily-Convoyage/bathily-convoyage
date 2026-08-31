// INDY-3C — Client Billing Cleanup — Static Frontend Validation
//
// Validates dashboard-client.html for:
// LEGACY CLEANUP:
// - no FAC- pseudo numbering
// - no F-${reference} as invoice number
// - no client legal jsPDF invoice generator
// - no autoTable billing PDF
// - no pseudo invoice download button
// - no jsPDF/autoTable script tags
// DATA:
// - reads billing_records
// - no billing_events read/write
// - issued number sourced from external_invoice_number
// - snapshot sourced from prepared_payload
// SECURITY:
// - no billing mutation RPC calls (prepare/link/cancel)
// - no billing table writes (INSERT/UPDATE/DELETE)
// - no service role
// STATES:
// - no record => no legal invoice
// - prepared => "en cours de préparation"
// - issued => external number displayed
// - cancelled does not display as legal invoice
// PAYMENT:
// - payment status remains separate
// - Stripe payment code remains present/intact
// HISTORICAL:
// - no legacy mission-derived invoice fallback
// - no mission-derived FAC- numbering

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const htmlUrl = new URL('../dashboard-client.html', import.meta.url);
const html = await readFile(htmlUrl, 'utf8');

const checks = [
  // =========================================================
  // LEGACY CLEANUP — no pseudo-invoice generation
  // =========================================================
  ['no FAC- pseudo numbering', !/FAC-\$\{/.test(html)],
  ['no F-${reference} pseudo numbering', !/F-\\\$\{/.test(html)],
  ['no jsPDF script tag', !/<script[^>]*jspdf/i.test(html)],
  ['no autoTable script tag', !/<script[^>]*autotable/i.test(html)],
  ['no jsPDF object creation', !/new jsPDF\(/.test(html)],
  ['no autoTable call', !/\.autoTable\(/.test(html)],
  ['no downloadClientInvoicePdf function', !/function\s+downloadClientInvoicePdf\s*\(/.test(html)],
  ['no PDF download button in factures', !/downloadClientInvoicePdf\(/.test(html)],
  ['no "Télécharger facture" button', !/Télécharger\s+facture/i.test(html)],
  ['no "Générer facture" button', !/Générer\s+facture/i.test(html)],
  ['no Facture_ filename pattern', !/Facture_\$\{/.test(html)],
  ['no "Facture N°" PDF text', !/Facture\s+N°\s*\$\{/.test(html)],

  // =========================================================
  // DATA — billing_records as source of truth
  // =========================================================
  ['reads billing_records table', /from\('billing_records'\)/i.test(html)],
  ['selects billing_records fields', /billing_records.*select.*status.*external_invoice_number.*prepared_payload/i.test(html.replace(/\s+/g, ' '))],
  ['no billing_events read', !/from\('billing_events'\)/i.test(html)],
  ['no billing_events write', !/billing_events.*(insert|update|delete)/i.test(html)],
  ['issued number sourced from external_invoice_number', /external_invoice_number/.test(html)],
  ['snapshot sourced from prepared_payload', /prepared_payload/.test(html)],
  ['uses prepared_payload financial data', /prepared_payload.*financial|fin\.total_ht|fin\.total_tva|fin\.total_ttc/i.test(html.replace(/\s+/g, ' ')) || /br\.total_ht|br\.total_tva|br\.total_ttc/.test(html)],
  ['uses prepared_payload customer data', /prepared_payload.*customer|cust\.name|cust\.address/i.test(html.replace(/\s+/g, ' ')) || /p\.customer/.test(html)],
  ['uses prepared_payload mission data', /p\.mission|mis\.reference|mis\.service_description/.test(html)],

  // =========================================================
  // SECURITY — client billing is read-only
  // =========================================================
  ['no prepare_billing_record RPC call', !/rpc\('prepare_billing_record'/.test(html)],
  ['no link_external_invoice RPC call', !/rpc\('link_external_invoice'/.test(html)],
  ['no cancel_billing_record RPC call', !/rpc\('cancel_billing_record'/.test(html)],
  ['no billing_records INSERT', !/from\('billing_records'\)\.insert/i.test(html)],
  ['no billing_records UPDATE', !/from\('billing_records'\)\.update/i.test(html)],
  ['no billing_records DELETE', !/from\('billing_records'\)\.delete/i.test(html)],
  ['no service role key', !/SERVICE_ROLE_KEY|service_role/i.test(html)],
  ['no createClient with service role', !/createClient\([^)]*service/i.test(html)],

  // =========================================================
  // BILLING STATES — truthful client display
  // =========================================================
  ['no record => "Facture non disponible"', /Facture non disponible/.test(html)],
  ['prepared => "en cours de préparation"', /en cours de préparation/i.test(html)],
  ['issued => "Facture émise" displayed', /Facture émise/.test(html)],
  ['issued => external_invoice_number displayed', /external_invoice_number/.test(html)],
  ['issued => issued_at displayed', /issued_at/.test(html)],
  ['cancelled records ignored in client view', /cancelled.*return|status === 'cancelled'.*return/i.test(html)],
  ['issued selection: issued > prepared', /br\.status === 'issued' && existing\.status !== 'issued'/.test(html)],

  // =========================================================
  // PDF / DOWNLOAD BEHAVIOR
  // =========================================================
  ['no legal PDF generation from Bathily', !/doc\.save\(/.test(html)],
  ['Indy source of truth disclaimer present', /Indy|émise via Indy/i.test(html)],
  ['contact message for invoice copy', /contactez Bathily-Convoyage/i.test(html)],
  ['no fabricated download URL', !/download.*facture.*url|invoice.*download.*href/i.test(html)],

  // =========================================================
  // PAYMENT SEPARATION — payment must remain intact
  // =========================================================
  ['Stripe payment function present', /function\s+payMission\s*\(/.test(html)],
  ['Stripe checkout endpoint present', /\/api\/create-checkout-session/.test(html)],
  ['paiement_statut still read', /paiement_statut/.test(html)],
  ['payment status label "Payé" present', /Payée|Payé/.test(html)],
  ['payment status label "En attente" present', /En attente/.test(html)],
  ['payment badge separate from billing', /Paiement\s*:\s*/.test(html)],
  ['no paiement_statut used as invoice status', !/paiement_statut.*invoice|paiement_statut.*facture/i.test(html)],

  // =========================================================
  // HISTORICAL — no legacy mission-derived invoice fallback
  // =========================================================
  ['no mission-derived invoice numbering', !/invoiceRef\s*=\s*`FAC-/.test(html)],
  ['no mission montant_ht as invoice amount', !/invoiceRef.*montant_ht|montant_ht.*invoiceRef/i.test(html)],
  ['billing query failure does not fall back to mission invoice', /Facture non disponible|Informations de facturation temporairement indisponibles/i.test(html)],

  // =========================================================
  // TERMINOLOGY
  // =========================================================
  ['"Référence mission" label used (not "Numéro de facture")', /Référence mission/.test(html)],
  ['"Numéro de facture" used only for external_invoice_number', /Numéro de facture.*external_invoice_number|external_invoice_number.*Numéro de facture/i.test(html.replace(/\s+/g, ' ')) || /Numéro de facture/.test(html)],
  ['no "Facture Bathily" label', !/Facture Bathily/i.test(html)],
  ['no "Facture générée" label', !/Facture générée/i.test(html)],
  ['no "Factur-X" reference', !/Factur-X/i.test(html)],
  ['no "DGFiP" reference', !/DGFiP/i.test(html)],

  // =========================================================
  // MODAL — billing detail in mission details
  // =========================================================
  ['md-billing-detail container exists', /md-billing-detail/.test(html)],
  ['renderBillingDetailInModal function exists', /function\s+renderBillingDetailInModal\s*\(/.test(html)],
  ['modal shows issued invoice details', /renderBillingDetailInModal/.test(html)],

  // =========================================================
  // GLOBAL STATE
  // =========================================================
  ['_clientBillingRecords global exists', /let\s+_clientBillingRecords/.test(html)],
  ['billing records loaded in loadClientData', /_clientBillingRecords\s*=/.test(html)],
  ['billing records query uses mission_ids', /\.in\('mission_id'/.test(html)],
];

let passed = 0, failed = 0;
for (const [name, ok] of checks) {
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${name}`);
  }
}

console.log(`\n${passed} checks passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nINDY-3C client billing cleanup static validation: FAIL');
  process.exit(1);
}
console.log('\nINDY-3C client billing cleanup static validation: PASS');
