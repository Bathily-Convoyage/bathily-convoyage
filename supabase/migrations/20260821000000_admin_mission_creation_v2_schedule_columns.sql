-- =====================================================
-- ADMIN-MISSION-CREATION-V2: Schedule columns
-- Gate A — LOCAL FILE ONLY. NOT EXECUTED in this gate.
-- =====================================================
-- Adds structured departure/arrival timestamps to public.missions.
--
-- Business timezone: Europe/Paris (explicit).
-- Stored values: UTC (timestamptz).
-- Legacy fields date_mission (date) and heure_depart (text) are
-- CONSERVED — no type change, no drop. They remain the fallback
-- for readers that have not migrated to departure_at.
--
-- No backfill in this migration. Legacy rows keep
-- departure_at = NULL and expected_arrival_at = NULL.
-- AMBIGUOUS_LEGACY_TIMES_REQUIRE_MANUAL_REVIEW=YES
-- A future separate gate will handle backfill with manual review
-- for nonexistent, malformed, missing and ambiguous legacy times.
-- =====================================================

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS departure_at timestamptz;

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS expected_arrival_at timestamptz;

-- Relational CHECK: expected_arrival_at > departure_at
-- PostgreSQL three-valued logic: if either operand is NULL,
-- the comparison yields NULL and the CHECK passes.
-- This is safe for the transition period where both columns
-- are NULL for legacy rows.
ALTER TABLE public.missions
  DROP CONSTRAINT IF EXISTS missions_arrival_after_departure;

ALTER TABLE public.missions
  ADD CONSTRAINT missions_arrival_after_departure
  CHECK (expected_arrival_at > departure_at);

COMMENT ON COLUMN public.missions.departure_at IS
  'Date/heure de départ prévue (UTC, timestamptz). Saisie en Europe/Paris puis convertie. Source de vérité pour le planning de départ. Legacy: date_mission + heure_depart (fallback).';

COMMENT ON COLUMN public.missions.expected_arrival_at IS
  'Date/heure d''arrivée prévue (UTC, timestamptz). Saisie en Europe/Paris puis convertie. Aucun équivalent legacy. NULL pour les missions existantes et les devis sans information d''arrivée.';

-- No index in this migration.
-- DEPARTURE_INDEX_DEFERRED=YES
-- A btree index on departure_at will be added in a future gate
-- when a concrete consumer (admin list sort, cron-relances fix)
-- is implemented. No anticipatory index without a query.
