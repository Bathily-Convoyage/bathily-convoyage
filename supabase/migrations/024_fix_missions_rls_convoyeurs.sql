-- Migration 024: Fix missions RLS for convoyeurs
-- 1. Fix missions_select_available_for_convoyeurs: use 'status' not 'statut'
-- 2. Fix missions_select_own_or_admin: match convoyeur_nom in addition to convoyeur_id
-- 3. Ensure convoyeur_id column exists on missions

-- Ensure convoyeur_id column exists
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS convoyeur_id uuid REFERENCES public.convoyeurs(id) ON DELETE SET NULL;

-- Drop old policies
DROP POLICY IF EXISTS "missions_select_own_or_admin" ON public.missions;
DROP POLICY IF EXISTS "missions_select_available_for_convoyeurs" ON public.missions;
DROP POLICY IF EXISTS "missions_select_active_anon" ON public.missions;

-- SELECT: admin sees all, client sees own, convoyeur sees available + assigned
CREATE POLICY "missions_select_own_or_admin"
  ON public.missions
  FOR SELECT
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        -- Client: match by client_id or client_email
        client_id IN (
          SELECT id FROM public.clients
          WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
        )
        OR client_email = (auth.jwt()->>'email')
        -- Convoyeur: match by convoyeur_id OR convoyeur_nom
        OR convoyeur_id IN (
          SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (prenom || ' ' || nom) FROM public.convoyeurs
          WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (nom || ' ' || prenom) FROM public.convoyeurs
          WHERE auth_user_id = auth.uid()
        )
      )
    )
    -- Convoyeur: can see available missions
    OR (
      auth.uid() IS NOT NULL
      AND status = 'available'
    )
  );

-- SELECT: anon access for active missions (tracking, EDL, bon-de-mission)
CREATE POLICY "missions_select_active_anon"
  ON public.missions
  FOR SELECT
  USING (
    auth.uid() IS NULL
    AND status IN ('in_progress', 'planned', 'available')
  );

-- UPDATE: admin or convoyeur (for EDL updates)
DROP POLICY IF EXISTS "missions_update_own_or_admin" ON public.missions;
CREATE POLICY "missions_update_own_or_admin"
  ON public.missions
  FOR UPDATE
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        convoyeur_id IN (SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid())
        OR convoyeur_nom IN (
          SELECT (prenom || ' ' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
      )
    )
  );

NOTIFY pgrst, 'reload schema';

-- =====================================================
-- Fix missions_update_active_anon: statut -> status
-- =====================================================
DROP POLICY IF EXISTS "missions_update_active_anon" ON public.missions;
CREATE POLICY "missions_update_active_anon"
  ON public.missions
  FOR UPDATE
  USING (
    auth.uid() IS NULL
    AND status IN ('planned', 'available', 'in_progress')
  )
  WITH CHECK (
    auth.uid() IS NULL
    AND status IN ('planned', 'available', 'in_progress', 'completed')
  );

NOTIFY pgrst, 'reload schema';
