-- =====================================================
-- Migration 039 : Programme fidélité + Parrainage
-- =====================================================

-- Table parrainages
CREATE TABLE IF NOT EXISTS public.parrainages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parrain_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parrain_email   TEXT NOT NULL,
  filleul_email   TEXT NOT NULL,
  filleul_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  code_parrain    TEXT NOT NULL UNIQUE,
  statut          TEXT NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'complete', 'paye')),
  recompense_parrain  INTEGER NOT NULL DEFAULT 10,
  recompense_filleul  INTEGER NOT NULL DEFAULT 10,
  mission_id      UUID REFERENCES public.missions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_parrainages_parrain ON public.parrainages (parrain_id);
CREATE INDEX IF NOT EXISTS idx_parrainages_code ON public.parrainages (code_parrain);
CREATE INDEX IF NOT EXISTS idx_parrainages_statut ON public.parrainages (statut);

-- RLS
ALTER TABLE public.parrainages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parrainages_select_own" ON public.parrainages;
CREATE POLICY "parrainages_select_own"
  ON public.parrainages FOR SELECT
  TO authenticated
  USING (parrain_id = auth.uid() OR filleul_id = auth.uid());

DROP POLICY IF EXISTS "parrainages_insert_own" ON public.parrainages;
CREATE POLICY "parrainages_insert_own"
  ON public.parrainages FOR INSERT
  TO authenticated
  WITH CHECK (parrain_id = auth.uid());

DROP POLICY IF EXISTS "parrainages_update_own" ON public.parrainages;
CREATE POLICY "parrainages_update_own"
  ON public.parrainages FOR UPDATE
  TO authenticated
  USING (parrain_id = auth.uid())
  WITH CHECK (parrain_id = auth.uid());

-- Table points_fidelite (historique des points)
CREATE TABLE IF NOT EXISTS public.points_fidelite (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  points      INTEGER NOT NULL,
  motif       TEXT NOT NULL,
  mission_id  UUID REFERENCES public.missions(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_points_user ON public.points_fidelite (user_id);

ALTER TABLE public.points_fidelite ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "points_select_own" ON public.points_fidelite;
CREATE POLICY "points_select_own"
  ON public.points_fidelite FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "points_insert_own" ON public.points_fidelite;
CREATE POLICY "points_insert_own"
  ON public.points_fidelite FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Vue pour le solde de points par utilisateur
CREATE OR REPLACE VIEW public.solde_fidelite AS
SELECT
  user_id,
  COALESCE(SUM(points), 0) AS solde_points,
  COUNT(*) AS nb_transactions
FROM public.points_fidelite
GROUP BY user_id;

GRANT SELECT ON public.solde_fidelite TO authenticated;

NOTIFY pgrst, 'reload schema';
