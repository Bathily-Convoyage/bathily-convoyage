-- =====================================================
-- MISSIONS-EXT-1 — External Platform Mission Sources
-- =====================================================
-- Adds explicit mission origin/source model so missions from
-- external convoyage platforms (Hiflow, Driiveme, ALB Convoyage,
-- other) can be integrated cleanly without pretending they are
-- direct client missions.
--
-- This migration is ADDITIVE and backward-compatible:
--   - source_mission defaults to 'direct' for all existing rows
--   - external_reference defaults to NULL for all existing rows
--   - no destructive rewrite
--   - no grant change
--
-- MISSIONS-EXT-1A additions:
--   - FIX 1: Narrow missions_select_b3 RLS so external available
--     missions are NOT readable by unrelated clients.
--   - FIX 2: Update enqueue_mission_notification() to skip client
--     notifications for external missions (no failed outbox rows).
--   - FIX 3: Strengthen CHECK to enforce canonical whitespace
--     (external_reference = btrim(external_reference)).
--
-- LOCAL FILE ONLY. NOT EXECUTED in this gate.
-- DO NOT apply to Production without explicit authorization.
-- =====================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- =====================================================
-- 1. source_mission column
-- =====================================================
-- NOT NULL DEFAULT 'direct' with strict CHECK allowlist.
-- All existing missions become source_mission='direct'.
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS source_mission text NOT NULL DEFAULT 'direct';

-- Drop and recreate the CHECK constraint to ensure the allowlist
-- is enforced even if the column was previously added without it.
ALTER TABLE public.missions
  DROP CONSTRAINT IF EXISTS missions_source_mission_check;

ALTER TABLE public.missions
  ADD CONSTRAINT missions_source_mission_check
  CHECK (source_mission IN ('direct','hiflow','driiveme','alb','other'));

-- =====================================================
-- 2. external_reference column
-- =====================================================
-- Nullable text. Structural business integrity is enforced by
-- the composite CHECK constraint below (required for external,
-- forbidden for direct) rather than relying only on UI validation.
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS external_reference text;

-- =====================================================
-- 3. Composite business-integrity CHECK (FIX 3: canonical whitespace)
-- =====================================================
-- direct missions: external_reference MUST be NULL
-- external missions: external_reference MUST be:
--   - NOT NULL
--   - non-empty after trim (btrim <> '')
--   - canonical whitespace: external_reference = btrim(external_reference)
--     (rejects leading/trailing spaces at DB level, not just UI)
--   - bounded to <= 120 characters
-- Case is NOT normalized (no lower()/upper()).
ALTER TABLE public.missions
  DROP CONSTRAINT IF EXISTS missions_external_reference_integrity;

ALTER TABLE public.missions
  ADD CONSTRAINT missions_external_reference_integrity
  CHECK (
    (source_mission = 'direct'  AND external_reference IS NULL)
    OR
    (source_mission <> 'direct'
     AND external_reference IS NOT NULL
     AND btrim(external_reference) <> ''
     AND external_reference = btrim(external_reference)
     AND length(external_reference) <= 120)
  );

-- =====================================================
-- 4. Partial unique index per platform
-- =====================================================
-- Ensures (source_mission, external_reference) is unique among
-- external missions only. Direct missions are excluded (they
-- always have external_reference = NULL).
-- Same reference on different platforms is allowed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_missions_external_ref_per_platform
  ON public.missions (source_mission, external_reference)
  WHERE source_mission <> 'direct';

-- =====================================================
-- 5. Index for admin filtering by source
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_missions_source_mission
  ON public.missions (source_mission);

-- =====================================================
-- 6. Comments
-- =====================================================
COMMENT ON COLUMN public.missions.source_mission IS
  'Origin of the mission: direct (Bathily client) or external platform (hiflow, driiveme, alb, other). Defaults to direct. Admin/internal metadata.';

COMMENT ON COLUMN public.missions.external_reference IS
  'External platform mission reference (e.g. HF-123456). Required when source_mission <> direct, NULL when direct. Max 120 chars. Canonical whitespace (no leading/trailing spaces). Unique per platform. Case preserved.';

-- =====================================================
-- 7. FIX 1 — RLS: Narrow missions_select_b3 for external available
-- =====================================================
-- The existing status='available' branch allowed any authenticated
-- user (including clients) to read available missions when
-- external_convoyeurs_enabled() = true. External missions contain
-- internal platform metadata and MUST NOT become readable to
-- unrelated clients.
--
-- New behavior:
--   - Direct available missions: preserve existing gate
--     (is_internal_user() OR external_convoyeurs_enabled())
--   - External available missions: visible only to internal users
--     (admin/operator) and convoyeurs (auth-linked convoyeur row).
--     NOT visible to clients.
--
-- Admin/operator are already covered by the top-level is_admin()
-- OR is_operator() branches, so they see all missions regardless.
-- This change only narrows the status='available' branch.
--
-- No widening. No new policy. No grant change.
-- =====================================================
ALTER POLICY "missions_select_b3" ON public.missions
  USING (
    public.is_admin()
    OR public.is_operator()
    OR client_id IN (
      SELECT c.id
      FROM public.clients c
      WHERE c.auth_user_id = (select auth.uid())
    )
    OR client_email = ((select auth.jwt()) ->> 'email')
    OR convoyeur_id IN (
      SELECT c.id
      FROM public.convoyeurs c
      WHERE c.auth_user_id = (select auth.uid())
        AND c.banned = false
    )
    OR (
      status = 'available'
      AND (
        -- Direct available missions: preserve existing gate
        (source_mission = 'direct'
         AND (public.is_internal_user() OR public.external_convoyeurs_enabled()))
        OR (
          -- External available missions: only when external_convoyeurs_enabled
          -- AND auth-linked non-banned convoyeur.
          -- Admin/operator bypass through top-level is_admin()/is_operator().
          -- Do NOT use is_internal_user() here — admin/operator already covered.
          source_mission <> 'direct'
          AND public.external_convoyeurs_enabled()
          AND EXISTS (
            SELECT 1
            FROM public.convoyeurs c
            WHERE c.auth_user_id = (select auth.uid())
              AND c.banned = false
          )
        )
      )
    )
  );

-- =====================================================
-- 8. FIX 2 — Notification: skip client outbox for external missions
-- =====================================================
-- The latest deployed definition of enqueue_mission_notification()
-- is from migration 20260809000007_phase3_b3v. The only later change
-- (20260824063918) revokes EXECUTE but does not modify the body.
--
-- External missions have client_id = NULL and client_email = NULL.
-- Enqueuing recipient_type='client' notifications for them produces
-- useless rows that later fail with "Destinataire introuvable".
--
-- Minimal source-aware condition: look up mission.source_mission
-- and skip the client INSERT when source_mission <> 'direct'.
-- Convoyeur notifications remain unchanged.
--
-- Direct missions: notification behavior unchanged.
-- =====================================================
CREATE OR REPLACE FUNCTION public.enqueue_mission_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _source_mission text;
BEGIN
  -- Look up the mission's source to skip client notifications for external missions
  SELECT m.source_mission INTO _source_mission
  FROM public.missions m
  WHERE m.id = NEW.mission_id;

  -- Default to 'direct' if mission not found (defensive — preserves legacy behavior)
  IF _source_mission IS NULL THEN
    _source_mission := 'direct';
  END IF;

  IF NEW.event_type IN ('mission_assigned', 'edl_departure_validated', 'mission_started', 'edl_arrival_validated', 'mission_delivered', 'mission_cancelled') THEN
    -- Client notification: skip for external missions (source_mission <> 'direct')
    -- External missions have no client; enqueuing would produce failed outbox rows.
    IF _source_mission = 'direct' THEN
      INSERT INTO public.notification_outbox (mission_id, mission_event_id, notification_type, recipient_type, payload, status)
      VALUES (
        NEW.mission_id,
        NEW.id,
        NEW.event_type,
        'client',
        jsonb_build_object(
          'event_type', NEW.event_type,
          'mission_id', NEW.mission_id,
          'metadata', COALESCE(NEW.metadata, '{}'::jsonb)
        ),
        'pending'
      )
      ON CONFLICT (mission_event_id, notification_type, recipient_type) DO NOTHING;
    END IF;

    -- Convoyeur notification: unchanged for both direct and external missions
    IF NEW.event_type IN ('mission_assigned', 'mission_cancelled') THEN
      INSERT INTO public.notification_outbox (mission_id, mission_event_id, notification_type, recipient_type, payload, status)
      VALUES (
        NEW.mission_id,
        NEW.id,
        NEW.event_type,
        'convoyeur',
        jsonb_build_object(
          'event_type', NEW.event_type,
          'mission_id', NEW.mission_id,
          'metadata', COALESCE(NEW.metadata, '{}'::jsonb)
        ),
        'pending'
      )
      ON CONFLICT (mission_event_id, notification_type, recipient_type) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- The trigger mission_events_enqueue_notification already exists from
-- migration 20260809000007. CREATE OR REPLACE FUNCTION updates the body
-- in place; the existing trigger will use the new definition.

COMMIT;
