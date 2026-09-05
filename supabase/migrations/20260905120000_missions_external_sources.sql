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
--   - no existing mission behavior change
--   - no RLS policy change
--   - no grant change
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
-- 3. Composite business-integrity CHECK
-- =====================================================
-- direct missions: external_reference MUST be NULL
-- external missions: external_reference MUST be non-null and non-empty
--   (trim <> '') and bounded to <= 120 characters.
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
     AND length(external_reference) <= 120)
  );

-- =====================================================
-- 4. Partial unique index per platform
-- =====================================================
-- Ensures (source_mission, external_reference) is unique among
-- external missions only. Direct missions are excluded (they
-- always have external_reference = NULL).
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
  'External platform mission reference (e.g. HF-123456). Required when source_mission <> direct, NULL when direct. Max 120 chars. Unique per platform.';

COMMIT;
