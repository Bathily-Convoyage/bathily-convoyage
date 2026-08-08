-- =====================================================
-- Migration 036 : Ajout des colonnes manquantes
--    Colonnes référencées par le frontend mais non
--    présentes dans les migrations 021-035
-- =====================================================
-- Toutes les additions utilisent IF NOT EXISTS pour
-- être idempotent et sans risque sur une base existante.
-- =====================================================

NOTIFY pgrst, 'reload schema';

-- =====================================================
-- 1. TABLE : missions
--    Colonnes lues/écrites par le frontend
-- =====================================================

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS trajet text,
  ADD COLUMN IF NOT EXISTS heure_depart text,
  ADD COLUMN IF NOT EXISTS annee text,
  ADD COLUMN IF NOT EXISTS carburant text,
  ADD COLUMN IF NOT EXISTS puissance text,
  ADD COLUMN IF NOT EXISTS type_vehicule text,
  ADD COLUMN IF NOT EXISTS mode_transport text,
  ADD COLUMN IF NOT EXISTS immatriculation text,
  ADD COLUMN IF NOT EXISTS client_telephone text,
  ADD COLUMN IF NOT EXISTS client_telephone_livraison text,
  ADD COLUMN IF NOT EXISTS client_address text,
  ADD COLUMN IF NOT EXISTS convoyeur_telephone text,
  ADD COLUMN IF NOT EXISTS zone_convoyeur text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS marge numeric,
  ADD COLUMN IF NOT EXISTS remuneration_convoyeur numeric,
  ADD COLUMN IF NOT EXISTS stripe_session_id text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Index pour les recherches fréquentes
CREATE INDEX IF NOT EXISTS idx_missions_client_email ON public.missions(client_email);
CREATE INDEX IF NOT EXISTS idx_missions_status ON public.missions(status);
CREATE INDEX IF NOT EXISTS idx_missions_convoyeur_id ON public.missions(convoyeur_id);

-- Trigger pour updated_at
DROP TRIGGER IF EXISTS trg_missions_updated_at ON public.missions;
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_missions_updated_at
  BEFORE UPDATE ON public.missions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =====================================================
-- 2. TABLE : devis
--    Colonnes utilisées par devis.html et dashboard-admin
-- =====================================================

ALTER TABLE public.devis
  ADD COLUMN IF NOT EXISTS client_id uuid,
  ADD COLUMN IF NOT EXISTS client_prenom text,
  ADD COLUMN IF NOT EXISTS client_nom text,
  ADD COLUMN IF NOT EXISTS client_email text,
  ADD COLUMN IF NOT EXISTS depart text,
  ADD COLUMN IF NOT EXISTS arrivee text,
  ADD COLUMN IF NOT EXISTS vehicule text,
  ADD COLUMN IF NOT EXISTS mode text,
  ADD COLUMN IF NOT EXISTS pack text,
  ADD COLUMN IF NOT EXISTS total_ht numeric,
  ADD COLUMN IF NOT EXISTS details jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS date_depart date;

-- =====================================================
-- 3. TABLE : vehicules
--    Utilisée par dashboard-client (gestion véhicules)
-- =====================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'vehicules'
  ) THEN
    CREATE TABLE public.vehicules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
      marque text,
      modele text,
      immatriculation text,
      type_vehicule text DEFAULT 'Automobile',
      created_at timestamptz DEFAULT now()
    );
    ALTER TABLE public.vehicules ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "vehicules_select_own" ON public.vehicules
      FOR SELECT USING (
        auth.uid() IS NOT NULL AND (
          client_id IN (SELECT id FROM public.clients WHERE auth_user_id = auth.uid())
          OR public.is_admin()
        )
      );
    CREATE POLICY "vehicules_insert_own" ON public.vehicules
      FOR INSERT WITH CHECK (
        auth.uid() IS NOT NULL AND (
          client_id IN (SELECT id FROM public.clients WHERE auth_user_id = auth.uid())
          OR public.is_admin()
        )
      );
    CREATE POLICY "vehicules_update_own" ON public.vehicules
      FOR UPDATE USING (
        auth.uid() IS NOT NULL AND (
          client_id IN (SELECT id FROM public.clients WHERE auth_user_id = auth.uid())
          OR public.is_admin()
        )
      );
    CREATE POLICY "vehicules_delete_own" ON public.vehicules
      FOR DELETE USING (
        auth.uid() IS NOT NULL AND (
          client_id IN (SELECT id FROM public.clients WHERE auth_user_id = auth.uid())
          OR public.is_admin()
        )
      );
  END IF;
END $$;

-- =====================================================
-- 4. TABLE : support_tickets
--    S'assurer que les colonnes admin existent
-- =====================================================

ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS client_id uuid,
  ADD COLUMN IF NOT EXISTS client_email text,
  ADD COLUMN IF NOT EXISTS client_nom text,
  ADD COLUMN IF NOT EXISTS sujet text,
  ADD COLUMN IF NOT EXISTS message text,
  ADD COLUMN IF NOT EXISTS reponse text,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- =====================================================
-- 5. TABLE : edls
--    Colonnes référencées par etat-des-lieux.html
-- =====================================================

ALTER TABLE public.edls
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS type text DEFAULT 'depart',
  ADD COLUMN IF NOT EXISTS mission_id uuid,
  ADD COLUMN IF NOT EXISTS convoyeur_nom text,
  ADD COLUMN IF NOT EXISTS email_client text,
  ADD COLUMN IF NOT EXISTS kilometage text,
  ADD COLUMN IF NOT EXISTS niveau_carburant text,
  ADD COLUMN IF NOT EXISTS conforme boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS dommages jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS photos jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS signatures jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- =====================================================
-- 6. TABLE : candidatures
--    S'assurer que convoyeur_id existe (déjà dans 022
--    mais on vérifie)
-- =====================================================

ALTER TABLE public.candidatures
  ADD COLUMN IF NOT EXISTS convoyeur_id uuid,
  ADD COLUMN IF NOT EXISTS convoyeur_nom text,
  ADD COLUMN IF NOT EXISTS mission_id uuid,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- =====================================================
-- 7. TABLE : clients
--    Colonnes référencées par le frontend
-- =====================================================

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS auth_user_id uuid,
  ADD COLUMN IF NOT EXISTS role text DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS prenom text,
  ADD COLUMN IF NOT EXISTS nom text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS telephone text,
  ADD COLUMN IF NOT EXISTS societe text,
  ADD COLUMN IF NOT EXISTS adresse text,
  ADD COLUMN IF NOT EXISTS code_postal text,
  ADD COLUMN IF NOT EXISTS ville text,
  ADD COLUMN IF NOT EXISTS siret text,
  ADD COLUMN IF NOT EXISTS tva text,
  ADD COLUMN IF NOT EXISTS notes text;

CREATE INDEX IF NOT EXISTS idx_clients_auth_user_id ON public.clients(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_clients_email ON public.clients(email);

-- =====================================================
-- 8. TABLE : convoyeurs
--    Colonnes référencées par le frontend
-- =====================================================

ALTER TABLE public.convoyeurs
  ADD COLUMN IF NOT EXISTS prenom text,
  ADD COLUMN IF NOT EXISTS nom text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS telephone text,
  ADD COLUMN IF NOT EXISTS ville text,
  ADD COLUMN IF NOT EXISTS auth_user_id uuid;

CREATE INDEX IF NOT EXISTS idx_convoyeurs_email ON public.convoyeurs(email);

-- =====================================================
-- 9. TABLE : convoyeur_candidatures
--    S'assurer que toutes les colonnes du frontend existent
-- =====================================================

ALTER TABLE public.convoyeur_candidatures
  ADD COLUMN IF NOT EXISTS prenom text,
  ADD COLUMN IF NOT EXISTS nom text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS telephone text,
  ADD COLUMN IF NOT EXISTS ville text,
  ADD COLUMN IF NOT EXISTS zone text,
  ADD COLUMN IF NOT EXISTS type_permis text,
  ADD COLUMN IF NOT EXISTS annee_permis integer,
  ADD COLUMN IF NOT EXISTS score_quiz integer,
  ADD COLUMN IF NOT EXISTS experience text,
  ADD COLUMN IF NOT EXISTS statut text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS documents jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- =====================================================
-- 10. VÉRIFICATION : colonnes optionnelles pour scripts
--     (stripe-export.js référence depart_ville, arrivee_ville,
--      distance_km — non critiques, avec fallback)
-- =====================================================

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS depart_ville text,
  ADD COLUMN IF NOT EXISTS arrivee_ville text,
  ADD COLUMN IF NOT EXISTS distance_km integer;

-- =====================================================
-- 11. S'assurer que RLS est activé sur toutes les tables
-- =====================================================

DO $$
BEGIN
  -- vehicules (si créé ici)
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'vehicules'
  ) THEN
    ALTER TABLE public.vehicules ENABLE ROW LEVEL SECURITY;
  END IF;

  -- devis
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'devis'
  ) THEN
    ALTER TABLE public.devis ENABLE ROW LEVEL SECURITY;

    -- Politiques devis si elles n'existent pas
    EXECUTE 'DROP POLICY IF EXISTS "devis_insert_public" ON public.devis';
    EXECUTE 'DROP POLICY IF EXISTS "devis_select_admin" ON public.devis';
    EXECUTE 'DROP POLICY IF EXISTS "devis_update_admin" ON public.devis';
    EXECUTE 'DROP POLICY IF EXISTS "devis_delete_admin" ON public.devis';

    EXECUTE 'CREATE POLICY "devis_insert_public" ON public.devis FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "devis_select_admin" ON public.devis FOR SELECT USING (public.is_admin())';
    EXECUTE 'CREATE POLICY "devis_update_admin" ON public.devis FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin())';
    EXECUTE 'CREATE POLICY "devis_delete_admin" ON public.devis FOR DELETE USING (public.is_admin())';
  END IF;

  -- support_tickets
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'support_tickets'
  ) THEN
    ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

    EXECUTE 'DROP POLICY IF EXISTS "tickets_insert_authenticated" ON public.support_tickets';
    EXECUTE 'DROP POLICY IF EXISTS "tickets_select_own_or_admin" ON public.support_tickets';
    EXECUTE 'DROP POLICY IF EXISTS "tickets_update_admin" ON public.support_tickets';

    EXECUTE 'CREATE POLICY "tickets_insert_authenticated" ON public.support_tickets FOR INSERT WITH CHECK (auth.uid() IS NOT NULL)';
    EXECUTE 'CREATE POLICY "tickets_select_own_or_admin" ON public.support_tickets FOR SELECT USING (
      public.is_admin()
      OR client_email = (SELECT email FROM public.clients WHERE auth_user_id = auth.uid())
      OR convoyeur_email = (SELECT email FROM public.convoyeurs WHERE auth_user_id = auth.uid())
    )';
    EXECUTE 'CREATE POLICY "tickets_update_admin" ON public.support_tickets FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin())';
  END IF;

  -- edls
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'edls'
  ) THEN
    ALTER TABLE public.edls ENABLE ROW LEVEL SECURITY;

    EXECUTE 'DROP POLICY IF EXISTS "edls_insert_authenticated" ON public.edls';
    EXECUTE 'DROP POLICY IF EXISTS "edls_select_own_or_admin" ON public.edls';
    EXECUTE 'DROP POLICY IF EXISTS "edls_update_own_or_admin" ON public.edls';

    EXECUTE 'CREATE POLICY "edls_insert_authenticated" ON public.edls FOR INSERT WITH CHECK (auth.uid() IS NOT NULL)';
    EXECUTE 'CREATE POLICY "edls_select_own_or_admin" ON public.edls FOR SELECT USING (
      public.is_admin()
      OR convoyeur_nom = (SELECT (prenom || '' '' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid())
      OR mission_id IN (SELECT id FROM public.missions WHERE client_email = (SELECT email FROM public.clients WHERE auth_user_id = auth.uid()))
    )';
    EXECUTE 'CREATE POLICY "edls_update_own_or_admin" ON public.edls FOR UPDATE USING (
      public.is_admin()
      OR convoyeur_nom = (SELECT (prenom || '' '' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid())
    )';
  END IF;

  -- candidatures
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'candidatures'
  ) THEN
    ALTER TABLE public.candidatures ENABLE ROW LEVEL SECURITY;

    EXECUTE 'DROP POLICY IF EXISTS "candidatures_insert_authenticated" ON public.candidatures';
    EXECUTE 'DROP POLICY IF EXISTS "candidatures_select_own_or_admin" ON public.candidatures';
    EXECUTE 'DROP POLICY IF EXISTS "candidatures_update_admin" ON public.candidatures';
    EXECUTE 'DROP POLICY IF EXISTS "candidatures_delete_admin" ON public.candidatures';

    EXECUTE 'CREATE POLICY "candidatures_insert_authenticated" ON public.candidatures FOR INSERT WITH CHECK (auth.uid() IS NOT NULL)';
    EXECUTE 'CREATE POLICY "candidatures_select_own_or_admin" ON public.candidatures FOR SELECT USING (
      public.is_admin()
      OR convoyeur_nom = (SELECT (prenom || '' '' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid())
    )';
    EXECUTE 'CREATE POLICY "candidatures_update_admin" ON public.candidatures FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin())';
    EXECUTE 'CREATE POLICY "candidatures_delete_admin" ON public.candidatures FOR DELETE USING (public.is_admin())';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
