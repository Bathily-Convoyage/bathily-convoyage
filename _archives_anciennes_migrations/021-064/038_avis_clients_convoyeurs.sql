-- =====================================================
-- Migration 038 : Système d'avis clients & convoyeurs
-- Table publique pour les avis (modération admin)
-- =====================================================

CREATE TABLE IF NOT EXISTS public.avis (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Auteur
  auteur_type   TEXT NOT NULL CHECK (auteur_type IN ('client', 'convoyeur', 'visiteur')),
  auteur_nom    TEXT NOT NULL,
  auteur_email  TEXT,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Contenu
  note          INTEGER NOT NULL CHECK (note >= 1 AND note <= 5),
  titre         TEXT,
  commentaire   TEXT NOT NULL,
  -- Contexte
  mission_id    UUID REFERENCES public.missions(id) ON DELETE SET NULL,
  ville         TEXT,
  type_service  TEXT, -- 'route', 'plateau', 'formation'
  -- Modération
  statut        TEXT NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'approuve', 'rejete')),
  reponse_admin TEXT,
  -- Métadonnées
  source        TEXT DEFAULT 'site', -- 'site', 'email_post_mission'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at   TIMESTAMPTZ
);

-- Index pour les performances
CREATE INDEX IF NOT EXISTS idx_avis_statut ON public.avis (statut);
CREATE INDEX IF NOT EXISTS idx_avis_note ON public.avis (note);
CREATE INDEX IF NOT EXISTS idx_avis_created ON public.avis (created_at DESC);

-- =====================================================
-- RLS Policies
-- =====================================================
ALTER TABLE public.avis ENABLE ROW LEVEL SECURITY;

-- Tout le monde peut lire les avis approuvés
DROP POLICY IF EXISTS "avis_select_approved" ON public.avis;
CREATE POLICY "avis_select_approved"
  ON public.avis FOR SELECT
  TO anon, authenticated
  USING (statut = 'approuve');

-- Tout le monde peut déposer un avis (public)
DROP POLICY IF EXISTS "avis_insert_public" ON public.avis;
CREATE POLICY "avis_insert_public"
  ON public.avis FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- L'auteur peut modifier son propre avis (tant qu'il n'est pas approuvé)
DROP POLICY IF EXISTS "avis_update_own" ON public.avis;
CREATE POLICY "avis_update_own"
  ON public.avis FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() AND statut = 'en_attente')
  WITH CHECK (user_id = auth.uid() AND statut = 'en_attente');

-- Admin peut tout faire (via service_role, bypass RLS)
-- Pas besoin de policy pour service_role

-- Trigger pour updated_at
CREATE OR REPLACE FUNCTION public.set_avis_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_avis_updated ON public.avis;
CREATE TRIGGER trg_avis_updated
  BEFORE UPDATE ON public.avis
  FOR EACH ROW
  EXECUTE FUNCTION public.set_avis_updated_at();

NOTIFY pgrst, 'reload schema';
