// INDY-3A — Billing Database Foundation — Static Migration Validation
//
// Validates the migration SQL for:
// - schema (tables, fields, indexes, constraints)
// - insert guard (born as prepared only)
// - terminal state immutability (unconditional, no postgres bypass)
// - prepared state core immutability
// - state machine legality
// - RLS / grants
// - billing_events append-only + admin-only
// - RPC authorization (is_admin, auth.uid)
// - duplicate primary invoice guard
// - external number uniqueness
// - prepared_payload server-side generation
// - billing workflow cutoff setting
// - no modification to existing tables/missions/Stripe

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
  '../supabase/migrations/20260830170100_indy_3a_billing_foundation.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');

// =========================================================
// SCHEMA: billing_records
// =========================================================

const billingRecordsChecks = [
  ['billing_records table created', /CREATE TABLE IF NOT EXISTS public\.billing_records\s*\(/i],
  ['id uuid PK', /id\s+uuid\s+DEFAULT gen_random_uuid\(\)\s+NOT NULL/i],
  ['mission_id uuid NOT NULL', /mission_id\s+uuid\s+NOT NULL\s+REFERENCES public\.missions\(id\)\s+ON DELETE RESTRICT/i],
  ['client_id uuid nullable', /client_id\s+uuid\s+REFERENCES public\.clients\(id\)\s+ON DELETE RESTRICT/i],
  ['provider text NOT NULL DEFAULT indy', /provider\s+text\s+NOT NULL\s+DEFAULT 'indy'/i],
  ['status text NOT NULL DEFAULT prepared', /status\s+text\s+NOT NULL\s+DEFAULT 'prepared'/i],
  ['invoice_type text NOT NULL DEFAULT invoice', /invoice_type\s+text\s+NOT NULL\s+DEFAULT 'invoice'/i],
  ['external_invoice_id text', /external_invoice_id\s+text/i],
  ['external_invoice_number text', /external_invoice_number\s+text/i],
  ['total_ht numeric NOT NULL', /total_ht\s+numeric\s+NOT NULL/i],
  ['total_tva numeric NOT NULL DEFAULT 0', /total_tva\s+numeric\s+NOT NULL\s+DEFAULT 0/i],
  ['total_ttc numeric NOT NULL', /total_ttc\s+numeric\s+NOT NULL/i],
  ['currency text NOT NULL DEFAULT EUR', /currency\s+text\s+NOT NULL\s+DEFAULT 'EUR'/i],
  ['prepared_payload jsonb NOT NULL', /prepared_payload\s+jsonb\s+NOT NULL/i],
  ['issued_at timestamptz', /issued_at\s+timestamptz/i],
  ['cancelled_at timestamptz', /cancelled_at\s+timestamptz/i],
  ['notes text', /notes\s+text/i],
  ['created_by uuid', /created_by\s+uuid/i],
  ['created_at timestamptz NOT NULL DEFAULT now', /created_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
  ['updated_at timestamptz NOT NULL DEFAULT now', /updated_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
];

for (const [name, pattern] of billingRecordsChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// SCHEMA: billing_events
// =========================================================

const billingEventsChecks = [
  ['billing_events table created', /CREATE TABLE IF NOT EXISTS public\.billing_events\s*\(/i],
  ['billing_events id uuid PK', /billing_events[\s\S]*id\s+uuid\s+DEFAULT gen_random_uuid\(\)\s+NOT NULL/i],
  ['billing_record_id uuid NOT NULL FK', /billing_record_id\s+uuid\s+NOT NULL\s+REFERENCES public\.billing_records\(id\)\s+ON DELETE RESTRICT/i],
  ['event_type text NOT NULL', /event_type\s+text\s+NOT NULL/i],
  ['from_status text', /from_status\s+text/i],
  ['to_status text', /to_status\s+text/i],
  ['actor_user_id uuid', /actor_user_id\s+uuid/i],
  ['actor_role text', /actor_role\s+text/i],
  ['metadata jsonb', /metadata\s+jsonb/i],
  ['billing_events created_at', /billing_events[\s\S]*created_at\s+timestamptz\s+NOT NULL\s+DEFAULT now\(\)/i],
];

for (const [name, pattern] of billingEventsChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// CONSTRAINTS
// =========================================================

const constraintChecks = [
  ['status CHECK prepared/issued/cancelled', /CHECK \(status IN \('prepared',\s*'issued',\s*'cancelled'\)\)/i],
  ['invoice_type CHECK invoice/credit_note', /CHECK \(invoice_type IN \('invoice',\s*'credit_note'\)\)/i],
  ['prepared no external_number', /CHECK \(status <> 'prepared' OR external_invoice_number IS NULL\)/i],
  ['prepared no external_id', /CHECK \(status <> 'prepared' OR external_invoice_id IS NULL\)/i],
  ['prepared no issued_at', /CHECK \(status <> 'prepared' OR issued_at IS NULL\)/i],
  ['prepared no cancelled_at', /CHECK \(status <> 'prepared' OR cancelled_at IS NULL\)/i],
  ['issued has external_number non-empty', /CHECK \(status <> 'issued' OR \(external_invoice_number IS NOT NULL\s*\n\s*AND btrim\(external_invoice_number\) <> ''\)\)/i],
  ['issued has issued_at', /CHECK \(status <> 'issued' OR issued_at IS NOT NULL\)/i],
  ['issued no cancelled_at', /CHECK \(status <> 'issued' OR cancelled_at IS NULL\)/i],
  ['cancelled no external_number', /CHECK \(status <> 'cancelled' OR external_invoice_number IS NULL\)/i],
  ['cancelled no external_id', /CHECK \(status <> 'cancelled' OR external_invoice_id IS NULL\)/i],
  ['cancelled no issued_at', /CHECK \(status <> 'cancelled' OR issued_at IS NULL\)/i],
  ['cancelled has cancelled_at', /CHECK \(status <> 'cancelled' OR cancelled_at IS NOT NULL\)/i],
  ['provider nonempty', /CHECK \(btrim\(provider\) <> ''\)/i],
  ['currency nonempty', /CHECK \(btrim\(currency\) <> ''\)/i],
  ['total_ht positive', /CHECK \(total_ht > 0\)/i],
  ['total_tva nonneg', /CHECK \(total_tva >= 0\)/i],
  ['total_ttc ge total_ht', /CHECK \(total_ttc >= total_ht\)/i],
];

for (const [name, pattern] of constraintChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// INDEXES
// =========================================================

const indexChecks = [
  ['unique one prepared per mission', /CREATE UNIQUE INDEX IF NOT EXISTS billing_records_one_prepared_per_mission_idx\s+ON public\.billing_records\(mission_id\)\s+WHERE status = 'prepared'/i],
  ['unique external number per provider', /CREATE UNIQUE INDEX IF NOT EXISTS billing_records_unique_external_number_per_provider_idx\s+ON public\.billing_records\(provider,\s*external_invoice_number\)\s+WHERE external_invoice_number IS NOT NULL/i],
  ['index mission_id', /CREATE INDEX IF NOT EXISTS billing_records_mission_id_idx/i],
  ['index status', /CREATE INDEX IF NOT EXISTS billing_records_status_idx/i],
  ['index client_id', /CREATE INDEX IF NOT EXISTS billing_records_client_id_idx/i],
  ['index issued_at', /CREATE INDEX IF NOT EXISTS billing_records_issued_at_idx/i],
  ['index billing_events billing_record_id', /CREATE INDEX IF NOT EXISTS billing_events_billing_record_id_idx/i],
  ['index billing_events created_at', /CREATE INDEX IF NOT EXISTS billing_events_created_at_idx/i],
];

for (const [name, pattern] of indexChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// INSERT GUARD
// =========================================================

const insertGuardChecks = [
  ['insert guard function exists', /CREATE OR REPLACE FUNCTION public\.billing_records_insert_guard\(\)/i],
  ['insert guard SECURITY INVOKER', /FUNCTION public\.billing_records_insert_guard\(\)[\s\S]*SECURITY INVOKER/i],
  ['insert guard rejects non-prepared', /IF NEW\.status <> 'prepared' THEN\s*\n\s*RAISE EXCEPTION/i],
  ['insert guard rejects external_invoice_number at creation', /IF NEW\.external_invoice_number IS NOT NULL THEN\s*\n\s*RAISE EXCEPTION 'external_invoice_number doit être NULL à la création'/i],
  ['insert guard rejects external_invoice_id at creation', /IF NEW\.external_invoice_id IS NOT NULL THEN\s*\n\s*RAISE EXCEPTION 'external_invoice_id doit être NULL à la création'/i],
  ['insert guard rejects issued_at at creation', /IF NEW\.issued_at IS NOT NULL THEN\s*\n\s*RAISE EXCEPTION 'issued_at doit être NULL à la création'/i],
  ['insert guard rejects cancelled_at at creation', /IF NEW\.cancelled_at IS NOT NULL THEN\s*\n\s*RAISE EXCEPTION 'cancelled_at doit être NULL à la création'/i],
  ['insert guard trigger BEFORE INSERT', /CREATE TRIGGER billing_records_insert_guard_trigger\s+BEFORE INSERT ON public\.billing_records/i],
  ['insert guard revoked from PUBLIC', /REVOKE EXECUTE ON FUNCTION public\.billing_records_insert_guard\(\) FROM PUBLIC/i],
];

for (const [name, pattern] of insertGuardChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// TERMINAL STATE IMMUTABILITY (billing_records_guard)
// =========================================================

const guardChecks = [
  ['guard function exists', /CREATE OR REPLACE FUNCTION public\.billing_records_guard\(\)/i],
  ['guard SECURITY INVOKER', /FUNCTION public\.billing_records_guard\(\)[\s\S]*SECURITY INVOKER/i],
  ['guard search_path empty', /FUNCTION public\.billing_records_guard\(\)[\s\S]*SET search_path = ''/i],
  ['guard NO postgres bypass', /guard\(\)[\s\S]*?BEGIN\s*\n\s*-- Layer 1[\s\S]*?IF OLD\.status IN \('issued', 'cancelled'\) THEN\s*\n\s*RAISE EXCEPTION/i],
  ['guard rejects issued terminal', /IF OLD\.status IN \('issued', 'cancelled'\) THEN\s*\n\s*RAISE EXCEPTION[\s\S]*terminal/i],
  ['guard rejects prepared to invalid', /IF OLD\.status = 'prepared' AND NEW\.status NOT IN \('issued', 'cancelled'\) THEN/i],
  ['guard mission_id immutable', /IF NEW\.mission_id IS DISTINCT FROM OLD\.mission_id THEN\s*\n\s*RAISE EXCEPTION 'mission_id est immuable'/i],
  ['guard client_id immutable', /IF NEW\.client_id IS DISTINCT FROM OLD\.client_id THEN\s*\n\s*RAISE EXCEPTION 'client_id est immuable'/i],
  ['guard provider immutable', /IF NEW\.provider IS DISTINCT FROM OLD\.provider THEN\s*\n\s*RAISE EXCEPTION 'provider est immuable'/i],
  ['guard total_ht immutable', /IF NEW\.total_ht IS DISTINCT FROM OLD\.total_ht THEN\s*\n\s*RAISE EXCEPTION 'total_ht est immuable'/i],
  ['guard prepared_payload immutable', /IF NEW\.prepared_payload IS DISTINCT FROM OLD\.prepared_payload THEN\s*\n\s*RAISE EXCEPTION 'prepared_payload est immuable'/i],
  ['guard created_at immutable', /IF NEW\.created_at IS DISTINCT FROM OLD\.created_at THEN\s*\n\s*RAISE EXCEPTION 'created_at est immuable'/i],
  ['guard trigger BEFORE UPDATE', /CREATE TRIGGER billing_records_guard_trigger\s+BEFORE UPDATE ON public\.billing_records/i],
  ['guard revoked from PUBLIC', /REVOKE EXECUTE ON FUNCTION public\.billing_records_guard\(\) FROM PUBLIC/i],
  ['guard has no current_user postgres bypass', /guard\(\)[\s\S]*?BEGIN[\s\S]*?Layer 1[\s\S]*?IF OLD\.status IN/i],
];

for (const [name, pattern] of guardChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// Explicitly verify NO postgres bypass in the guard
assert.doesNotMatch(
  sql.replace(/billing_records_insert_guard[\s\S]*?END;\s*\$\$/i, ''),
  /billing_records_guard\(\)[\s\S]*?IF current_user = 'postgres' THEN\s*\n\s*RETURN NEW;/i,
  'billing_records_guard must NOT have a postgres bypass',
);
console.log('  ✓ billing_records_guard has NO postgres/current_user bypass');

// =========================================================
// BILLING_EVENTS APPEND-ONLY
// =========================================================

const eventsGuardChecks = [
  ['events protect function exists', /CREATE OR REPLACE FUNCTION public\.billing_events_protect\(\)/i],
  ['events protect SECURITY INVOKER', /FUNCTION public\.billing_events_protect\(\)[\s\S]*SECURITY INVOKER/i],
  ['events protect rejects UPDATE and DELETE', /RAISE EXCEPTION 'billing_events est strictement append-only : % interdit', TG_OP/i],
  ['events protect trigger BEFORE UPDATE OR DELETE', /CREATE TRIGGER billing_events_protect_trigger\s+BEFORE UPDATE OR DELETE ON public\.billing_events/i],
  ['events protect revoked from PUBLIC', /REVOKE EXECUTE ON FUNCTION public\.billing_events_protect\(\) FROM PUBLIC/i],
];

for (const [name, pattern] of eventsGuardChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// RLS: billing_records
// =========================================================

const rlsBillingRecordsChecks = [
  ['billing_records ENABLE RLS', /ALTER TABLE public\.billing_records ENABLE ROW LEVEL SECURITY/i],
  ['billing_records FORCE RLS', /ALTER TABLE public\.billing_records FORCE ROW LEVEL SECURITY/i],
  ['billing_records REVOKE ALL FROM PUBLIC', /REVOKE ALL ON public\.billing_records FROM PUBLIC/i],
  ['billing_records REVOKE ALL FROM anon', /REVOKE ALL ON public\.billing_records FROM anon/i],
  ['billing_records REVOKE ALL FROM authenticated', /REVOKE ALL ON public\.billing_records FROM authenticated/i],
  ['billing_records GRANT SELECT to authenticated', /GRANT SELECT ON public\.billing_records TO authenticated/i],
  ['billing_records admin select policy', /CREATE POLICY "billing_records_admin_select"[\s\S]*USING \(public\.is_admin\(\)\)/i],
  ['billing_records client select own policy', /CREATE POLICY "billing_records_client_select_own"[\s\S]*EXISTS[\s\S]*public\.missions m[\s\S]*m\.id = billing_records\.mission_id/i],
  ['no billing_records INSERT policy', /(?<!SELECT )FOR INSERT/i],
];

for (const [name, pattern] of rlsBillingRecordsChecks) {
  // The INSERT policy check is negative — we want to ensure NO FOR INSERT policy exists
  if (name === 'no billing_records INSERT policy') {
    assert.doesNotMatch(
      sql.match(/CREATE POLICY "billing_records[^"]*"[\s\S]*?FOR INSERT/i)?.[0] || '',
      /FOR INSERT/i,
      'billing_records must not have INSERT policy',
    );
    console.log(`  ✓ ${name}`);
  } else {
    assert.match(sql, pattern, name);
    console.log(`  ✓ ${name}`);
  }
}

// =========================================================
// RLS: billing_events (admin-only)
// =========================================================

const rlsBillingEventsChecks = [
  ['billing_events ENABLE RLS', /ALTER TABLE public\.billing_events ENABLE ROW LEVEL SECURITY/i],
  ['billing_events FORCE RLS', /ALTER TABLE public\.billing_events FORCE ROW LEVEL SECURITY/i],
  ['billing_events REVOKE ALL FROM PUBLIC', /REVOKE ALL ON public\.billing_events FROM PUBLIC/i],
  ['billing_events REVOKE ALL FROM anon', /REVOKE ALL ON public\.billing_events FROM anon/i],
  ['billing_events REVOKE ALL FROM authenticated', /REVOKE ALL ON public\.billing_events FROM authenticated/i],
  ['billing_events GRANT SELECT to authenticated', /GRANT SELECT ON public\.billing_events TO authenticated/i],
  ['billing_events admin-only select policy', /CREATE POLICY "billing_events_admin_select_only"[\s\S]*USING \(public\.is_admin\(\)\)/i],
];

for (const [name, pattern] of rlsBillingEventsChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// Verify no client SELECT policy on billing_events
assert.doesNotMatch(
  sql,
  /CREATE POLICY "billing_events_client[^"]*"/i,
  'billing_events must NOT have client SELECT policy',
);
console.log('  ✓ billing_events has NO client SELECT policy (admin-only)');

// =========================================================
// RPC: log_billing_event (internal)
// =========================================================

const logEventChecks = [
  ['log_billing_event function exists', /CREATE OR REPLACE FUNCTION public\.log_billing_event\(/i],
  ['log_billing_event SECURITY DEFINER', /FUNCTION public\.log_billing_event\([\s\S]*SECURITY DEFINER/i],
  ['log_billing_event search_path empty', /FUNCTION public\.log_billing_event\([\s\S]*SET search_path = ''/i],
  ['log_billing_event uses auth.uid for actor', /INSERT INTO public\.billing_events[\s\S]*actor_user_id[\s\S]*VALUES[\s\S]*auth\.uid\(\)/i],
  ['log_billing_event revoked from PUBLIC/anon/authenticated/service_role', /REVOKE EXECUTE ON FUNCTION public\.log_billing_event\(uuid, text, text, text, text, jsonb\)\s+FROM PUBLIC, anon, authenticated, service_role/i],
];

for (const [name, pattern] of logEventChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// RPC: prepare_billing_record
// =========================================================

const prepareChecks = [
  ['prepare_billing_record function exists', /CREATE OR REPLACE FUNCTION public\.prepare_billing_record\(/i],
  ['prepare_billing_record SECURITY DEFINER', /FUNCTION public\.prepare_billing_record\([\s\S]*SECURITY DEFINER/i],
  ['prepare_billing_record search_path empty', /FUNCTION public\.prepare_billing_record\([\s\S]*SET search_path = ''/i],
  ['prepare requires auth.uid', /v_actor_id uuid := auth\.uid\(\);[\s\S]*IF v_actor_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Authentification requise'/i],
  ['prepare requires is_admin', /IF NOT public\.is_admin\(\) THEN\s*\n\s*RAISE EXCEPTION 'Réservé à l''administrateur'/i],
  ['prepare validates mission exists', /SELECT \* INTO v_mission FROM public\.missions WHERE id = p_mission_id;[\s\S]*IF NOT FOUND THEN/i],
  ['prepare validates montant_ht > 0', /IF v_mission\.montant_ht IS NULL OR v_mission\.montant_ht <= 0 THEN/i],
  ['prepare rejects duplicate active primary invoice', /IF EXISTS \(\s*SELECT 1 FROM public\.billing_records\s*WHERE mission_id = p_mission_id\s*AND invoice_type = 'invoice'\s*AND status IN \('prepared', 'issued'\)/i],
  ['prepare inserts status prepared', /INSERT INTO public\.billing_records[\s\S]*'prepared'/i],
  ['prepare sets created_by to auth.uid', /created_by[\s\S]*v_actor_id/i],
  ['prepare logs billing_record_created event', /PERFORM public\.log_billing_event\([\s\S]*'billing_record_created'/i],
  ['prepare returns billing_record id', /RETURN v_billing_id/i],
  ['prepare revoked from PUBLIC/anon', /REVOKE EXECUTE ON FUNCTION public\.prepare_billing_record\(uuid, text\) FROM PUBLIC, anon/i],
  ['prepare granted to authenticated', /GRANT EXECUTE ON FUNCTION public\.prepare_billing_record\(uuid, text\) TO authenticated/i],
];

for (const [name, pattern] of prepareChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// PREPARED_PAYLOAD SERVER-SIDE GENERATION
// =========================================================

const payloadChecks = [
  ['payload built with jsonb_build_object', /v_prepared_payload := jsonb_build_object\(/i],
  ['payload has seller', /'seller', jsonb_build_object\(/i],
  ['payload seller name Bathily-Convoyage', /'name', 'Bathily-Convoyage'/i],
  ['payload seller SIRET', /'siret', '789 285 376 00032'/i],
  ['payload seller address', /'address', '34, rue de Padirac 34070 Montpellier'/i],
  ['payload seller email', /'email', 'contact@bathily-convoyage\.fr'/i],
  ['payload seller tva_regime', /'tva_regime', 'TVA non applicable — franchise en base \(art\. 293 B CGI\)'/i],
  ['payload has customer', /'customer', jsonb_build_object\(/i],
  ['payload customer email from DB', /'email', COALESCE\(v_client\.email, v_mission\.client_email\)/i],
  ['payload customer address from DB', /'address', COALESCE\(v_client\.adresse, v_mission\.client_address\)/i],
  ['payload customer siret from DB', /'siret', v_client\.siret/i],
  ['payload customer tva_intra from DB', /'tva_intra', v_client\.tva_intra/i],
  ['payload has mission', /'mission', jsonb_build_object\(/i],
  ['payload mission reference from DB', /'reference', v_mission\.reference/i],
  ['payload has financial', /'financial', jsonb_build_object\(/i],
  ['payload financial total_ht from mission', /'total_ht', v_total_ht/i],
  ['payload financial tva_rate 0', /'tva_rate', 0/i],
];

for (const [name, pattern] of payloadChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// Verify payload is NOT accepted from parameters
assert.doesNotMatch(
  sql,
  /p_prepared_payload/i,
  'prepare_billing_record must NOT accept prepared_payload as a parameter',
);
console.log('  ✓ prepared_payload is NOT a parameter (server-side only)');

// =========================================================
// RPC: link_external_invoice
// =========================================================

const linkChecks = [
  ['link_external_invoice function exists', /CREATE OR REPLACE FUNCTION public\.link_external_invoice\(/i],
  ['link SECURITY DEFINER', /FUNCTION public\.link_external_invoice\([\s\S]*SECURITY DEFINER/i],
  ['link search_path empty', /FUNCTION public\.link_external_invoice\([\s\S]*SET search_path = ''/i],
  ['link requires auth.uid', /v_actor_id uuid := auth\.uid\(\);[\s\S]*IF v_actor_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Authentification requise'/i],
  ['link requires is_admin', /IF NOT public\.is_admin\(\) THEN\s*\n\s*RAISE EXCEPTION 'Réservé à l''administrateur'/i],
  ['link trims external number', /v_trimmed_number := btrim\(p_external_invoice_number\)/i],
  ['link rejects empty number', /IF v_trimmed_number IS NULL OR v_trimmed_number = '' THEN/i],
  ['link bounds number length', /IF length\(v_trimmed_number\) > 100 THEN/i],
  ['link locks record FOR UPDATE', /FROM public\.billing_records\s*WHERE id = p_billing_record_id\s*FOR UPDATE/i],
  ['link requires status prepared', /IF v_record\.status <> 'prepared' THEN/i],
  ['link atomic CAS transition', /UPDATE public\.billing_records\s+SET\s+status = 'issued'[\s\S]*WHERE id = p_billing_record_id\s+AND status = 'prepared'/i],
  ['link sets issued_at', /issued_at = now\(\)/i],
  ['link sets external_invoice_number', /external_invoice_number = v_trimmed_number/i],
  ['link logs issued event', /PERFORM public\.log_billing_event\([\s\S]*'issued'/i],
  ['link revoked from PUBLIC/anon', /REVOKE EXECUTE ON FUNCTION public\.link_external_invoice\(uuid, text, text\) FROM PUBLIC, anon/i],
  ['link granted to authenticated', /GRANT EXECUTE ON FUNCTION public\.link_external_invoice\(uuid, text, text\) TO authenticated/i],
];

for (const [name, pattern] of linkChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// Verify single 'issued' event (not redundant invoice_linked + issued)
// Match log_billing_event calls where 'issued' is the event_type (2nd argument)
const issuedEvents = sql.match(/PERFORM public\.log_billing_event\(\s*p_billing_record_id,\s*'issued'/g) || [];
assert.equal(issuedEvents.length, 1, 'link_external_invoice must log exactly ONE issued event');
console.log('  ✓ link logs exactly ONE issued event (no redundant invoice_linked)');

// =========================================================
// RPC: cancel_billing_record
// =========================================================

const cancelChecks = [
  ['cancel_billing_record function exists', /CREATE OR REPLACE FUNCTION public\.cancel_billing_record\(/i],
  ['cancel SECURITY DEFINER', /FUNCTION public\.cancel_billing_record\([\s\S]*SECURITY DEFINER/i],
  ['cancel search_path empty', /FUNCTION public\.cancel_billing_record\([\s\S]*SET search_path = ''/i],
  ['cancel requires auth.uid', /v_actor_id uuid := auth\.uid\(\);[\s\S]*IF v_actor_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Authentification requise'/i],
  ['cancel requires is_admin', /IF NOT public\.is_admin\(\) THEN\s*\n\s*RAISE EXCEPTION 'Réservé à l''administrateur'/i],
  ['cancel locks record FOR UPDATE', /FROM public\.billing_records\s*WHERE id = p_billing_record_id\s*FOR UPDATE/i],
  ['cancel requires status prepared', /IF v_record\.status <> 'prepared' THEN/i],
  ['cancel rejects issued with explicit message', /Une facture émise ne peut pas être annulée/i],
  ['cancel atomic CAS transition', /UPDATE public\.billing_records\s+SET\s+status = 'cancelled'[\s\S]*WHERE id = p_billing_record_id\s+AND status = 'prepared'/i],
  ['cancel sets cancelled_at', /cancelled_at = now\(\)/i],
  ['cancel preserves reason', /notes = COALESCE\(p_reason, notes\)/i],
  ['cancel logs cancelled event', /PERFORM public\.log_billing_event\([\s\S]*'cancelled'/i],
  ['cancel revoked from PUBLIC/anon', /REVOKE EXECUTE ON FUNCTION public\.cancel_billing_record\(uuid, text\) FROM PUBLIC, anon/i],
  ['cancel granted to authenticated', /GRANT EXECUTE ON FUNCTION public\.cancel_billing_record\(uuid, text\) TO authenticated/i],
];

for (const [name, pattern] of cancelChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// BILLING WORKFLOW CUTOFF
// =========================================================

const cutoffChecks = [
  ['cutoff uses app_settings', /INSERT INTO public\.app_settings \(key, value, updated_by\)/i],
  ['cutoff key is billing_workflow_start_at', /'billing_workflow_start_at'/i],
  ['cutoff value is timestamp', /to_jsonb\(now\(\)\)/i],
  ['cutoff does not overwrite existing', /WHERE NOT EXISTS \(\s*SELECT 1 FROM public\.app_settings WHERE key = 'billing_workflow_start_at'/i],
  ['cutoff ON CONFLICT DO NOTHING', /ON CONFLICT \(key\) DO NOTHING/i],
];

for (const [name, pattern] of cutoffChecks) {
  assert.match(sql, pattern, name);
  console.log(`  ✓ ${name}`);
}

// =========================================================
// MIGRATION SAFETY
// =========================================================

// Must be wrapped in transaction
assert.match(sql, /^BEGIN;/m, 'migration must start with BEGIN');
assert.match(sql, /COMMIT;\s*$/m, 'migration must end with COMMIT');
console.log('  ✓ migration wrapped in BEGIN/COMMIT');

// Must NOT modify existing tables (no ALTER TABLE on missions/clients/devis)
assert.doesNotMatch(
  sql,
  /ALTER TABLE public\.(missions|clients|devis|mission_events|user_roles|app_settings)\s+(ADD|DROP|RENAME|ALTER)/i,
  'migration must NOT alter existing tables (missions, clients, devis, etc.)',
);
console.log('  ✓ no ALTER TABLE on existing tables');

// Must NOT drop existing tables
assert.doesNotMatch(
  sql,
  /DROP TABLE\s+(IF EXISTS\s+)?public\.(missions|clients|devis|mission_events|user_roles|app_settings|billing_records|billing_events)/i,
  'migration must NOT drop any existing or new billing tables',
);
console.log('  ✓ no DROP TABLE on existing or new tables');

// Must NOT modify Stripe RPCs
assert.doesNotMatch(
  sql,
  /CREATE OR REPLACE FUNCTION public\.(create_checkout_session|stripe_webhook|complete_stripe_checkout_payment|mark_mission_paid|replace_stripe_checkout_session|record_stripe_checkout_session|transition_mission_status)/i,
  'migration must NOT modify existing mission/Stripe RPCs',
);
console.log('  ✓ no modification to existing mission/Stripe RPCs');

// Must NOT change paiement_statut
assert.doesNotMatch(
  sql,
  /paiement_statut.*CHECK|CHECK.*paiement_statut/i,
  'migration must NOT change paiement_statut constraints',
);
console.log('  ✓ no paiement_statut constraint changes');

// =========================================================
// NO ANON GRANTS
// =========================================================

assert.doesNotMatch(
  sql,
  /GRANT EXECUTE ON FUNCTION public\.(prepare_billing_record|link_external_invoice|cancel_billing_record|log_billing_event)[^;]+TO anon/i,
  'no billing RPC may be granted to anon',
);
console.log('  ✓ no billing RPC granted to anon');

// =========================================================
// SUMMARY
// =========================================================

const totalChecks =
  billingRecordsChecks.length +
  billingEventsChecks.length +
  constraintChecks.length +
  indexChecks.length +
  insertGuardChecks.length +
  guardChecks.length +
  eventsGuardChecks.length +
  rlsBillingRecordsChecks.length +
  rlsBillingEventsChecks.length +
  logEventChecks.length +
  prepareChecks.length +
  payloadChecks.length +
  linkChecks.length +
  cancelChecks.length +
  cutoffChecks.length +
  10; // additional manual checks

console.log(`\n${totalChecks} checks passed, 0 failed`);
console.log('INDY-3A migration static validation: PASS');
