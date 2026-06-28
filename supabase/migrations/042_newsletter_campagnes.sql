-- =====================================================
-- Migration 042 : Newsletter + campagnes email
-- =====================================================

-- Table newsletter_subscribers
CREATE TABLE IF NOT EXISTS public.newsletter_subscribers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  nom         TEXT,
  source      TEXT NOT NULL DEFAULT 'homepage',
  statut      TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'desinscrit', 'bounce')),
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_email ON public.newsletter_subscribers (email);
CREATE INDEX IF NOT EXISTS idx_newsletter_statut ON public.newsletter_subscribers (statut);

ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;

-- Tout le monde peut s'inscrire (insert public)
DROP POLICY IF EXISTS "newsletter_insert_public" ON public.newsletter_subscribers;
CREATE POLICY "newsletter_insert_public"
  ON public.newsletter_subscribers FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Tout le monde peut se desinscrire (update son email)
DROP POLICY IF EXISTS "newsletter_update_public" ON public.newsletter_subscribers;
CREATE POLICY "newsletter_update_public"
  ON public.newsletter_subscribers FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- Seul l'admin peut lire la liste
DROP POLICY IF EXISTS "newsletter_select_admin" ON public.newsletter_subscribers;
CREATE POLICY "newsletter_select_admin"
  ON public.newsletter_subscribers FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Table campagnes
CREATE TABLE IF NOT EXISTS public.campagnes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sujet       TEXT NOT NULL,
  contenu     TEXT NOT NULL,
  statut      TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon', 'envoyee', 'planifiee')),
  destinataires INTEGER NOT NULL DEFAULT 0,
  envoyee_le  TIMESTAMPTZ,
  created_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.campagnes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "campagnes_admin_all" ON public.campagnes;
CREATE POLICY "campagnes_admin_all"
  ON public.campagnes FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

NOTIFY pgrst, 'reload schema';
