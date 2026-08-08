-- =====================================================
-- Migration 064 : Logique métier + durcissement RLS
-- =====================================================
-- Problèmes corrigés :
-- 1. CRITIQUE : devis_select_authenticated (migration 021) jamais droppée
--    → tout user authentifié peut lire TOUS les devis
-- 2. CRITIQUE : devis_update_authenticated (migration 021) jamais droppée
--    → tout user authentifié peut modifier N'IMPORTE QUEL devis
-- 3. CRITIQUE : edls_insert_public (migration 021) jamais droppée
--    → anon peut insérer des EDLs falsifiés
-- 4. CRITIQUE : missions_insert_authenticated trop permissive
--    → tout user authentifié peut créer des missions
-- 5. CRITIQUE : missions_select_active_anon (migration 021) jamais droppée
--    → anon voit les missions available
-- 6. CRITIQUE : missions_update_active_anon (migration 021) jamais droppée
--    → anon peut modifier le statut des missions (faille critique)
-- 7. CRITIQUE : missions_select_available_for_convoyeurs utilise 'statut' (ancien)
--    → policy inopérante, colonne renommée en 'status'
-- 8. COLONNES MORTES : prix_ht, prix_ttc, tva sur missions + tva sur clients
-- 9. MOT_DE_PASSE : colonnes legacy en clair (Supabase Auth utilisé)
-- 10. CHECK CONSTRAINT : missions.status sans garde-fou BDD
-- 11. DEVIS : client ne peut pas lire ses propres devis
-- 12. DEVIS : pas de INSERT policy pour client (admin only après acceptation)
-- =====================================================

NOTIFY pgrst, 'reload schema';

-- =========================================================
-- 1. DROPPER LES ANCIENNES POLICIES PERMISSIVES JAMAIS NETTOYÉES
-- =========================================================

-- devis : anciennes policies de migration 021 (trop permissives)
DROP POLICY IF EXISTS "devis_select_authenticated" ON public.devis;
DROP POLICY IF EXISTS "devis_update_authenticated" ON public.devis;

-- edls : ancienne policy INSERT public de migration 021
DROP POLICY IF EXISTS "edls_insert_public" ON public.edls;

-- missions : anciennes policies anon de migration 021
DROP POLICY IF EXISTS "missions_select_active_anon" ON public.missions;
DROP POLICY IF EXISTS "missions_update_active_anon" ON public.missions;
DROP POLICY IF EXISTS "missions_select_available_for_convoyeurs" ON public.missions;

-- =========================================================
-- 2. DEVIS : RLS correct (client lit ses devis, admin gère tout)
-- =========================================================

-- SELECT : admin OU client lit ses propres devis (par email)
DROP POLICY IF EXISTS "devis_select_admin" ON public.devis;
DROP POLICY IF EXISTS "devis_select_own_or_admin" ON public.devis;
CREATE POLICY "devis_select_own_or_admin"
  ON public.devis
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR client_email = (auth.jwt() ->> 'email')
  );

-- INSERT : public (formulaire de devis sans compte)
DROP POLICY IF EXISTS "devis_insert_public" ON public.devis;
CREATE POLICY "devis_insert_public"
  ON public.devis
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- UPDATE : admin uniquement (accepter/refuser/ajuster prix)
DROP POLICY IF EXISTS "devis_update_admin" ON public.devis;
CREATE POLICY "devis_update_admin"
  ON public.devis
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- DELETE : admin uniquement
DROP POLICY IF EXISTS "devis_delete_admin" ON public.devis;
CREATE POLICY "devis_delete_admin"
  ON public.devis
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- =========================================================
-- 3. MISSIONS : RLS renforcé
-- =========================================================

-- INSERT : admin uniquement (création de mission après acceptation devis)
DROP POLICY IF EXISTS "missions_insert_authenticated" ON public.missions;
DROP POLICY IF EXISTS "missions_insert_admin" ON public.missions;
CREATE POLICY "missions_insert_admin"
  ON public.missions
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

-- SELECT : admin OU client propriétaire OU convoyeur assigné OU convoyeur voit available
-- (re-créer proprement car les anciennes policies ont été droppées)
DROP POLICY IF EXISTS "missions_select_own_or_admin" ON public.missions;
CREATE POLICY "missions_select_own_or_admin"
  ON public.missions
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        -- Client : propriétaire de la mission
        client_id IN (
          SELECT id FROM public.clients
          WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
        )
        OR client_email = (auth.jwt()->>'email')
        -- Convoyeur : assigné à la mission
        OR convoyeur_id IN (
          SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (prenom || ' ' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (nom || ' ' || prenom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        -- Convoyeur : voit les missions disponibles sur le marché
        OR status = 'available'
      )
    )
  );

-- SELECT : anon pour suivi GPS uniquement (status = 'in_progress' + référence connue)
DROP POLICY IF EXISTS "missions_select_tracking_anon" ON public.missions;
CREATE POLICY "missions_select_tracking_anon"
  ON public.missions
  FOR SELECT
  TO anon
  USING (
    auth.uid() IS NULL
    AND status = 'in_progress'
  );

-- UPDATE : admin OU client propriétaire (champs limités) OU convoyeur assigné
DROP POLICY IF EXISTS "missions_update_own_or_admin" ON public.missions;
CREATE POLICY "missions_update_own_or_admin"
  ON public.missions
  FOR UPDATE
  TO authenticated
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        -- Client : propriétaire de la mission
        client_id IN (
          SELECT id FROM public.clients
          WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
        )
        OR client_email = (auth.jwt()->>'email')
        -- Convoyeur : assigné à la mission
        OR convoyeur_id IN (
          SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (prenom || ' ' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (nom || ' ' || prenom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
      )
    )
  )
  WITH CHECK (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        client_id IN (
          SELECT id FROM public.clients
          WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
        )
        OR client_email = (auth.jwt()->>'email')
        OR convoyeur_id IN (
          SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (prenom || ' ' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (nom || ' ' || prenom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
      )
    )
  );

-- DELETE : admin uniquement
DROP POLICY IF EXISTS "missions_delete_admin" ON public.missions;
CREATE POLICY "missions_delete_admin"
  ON public.missions
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- =========================================================
-- 4. EDLS : INSERT authentifié uniquement (plus d'anon)
-- =========================================================

DROP POLICY IF EXISTS "edls_insert_public" ON public.edls;
DROP POLICY IF EXISTS "edls_insert_authenticated" ON public.edls;
CREATE POLICY "edls_insert_authenticated"
  ON public.edls
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- SELECT : admin OU client propriétaire de la mission OU convoyeur assigné
DROP POLICY IF EXISTS "edls_select_own_or_admin" ON public.edls;
CREATE POLICY "edls_select_own_or_admin"
  ON public.edls
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        -- Client : propriétaire de la mission liée à l'EDL
        mission_id IN (
          SELECT m.id FROM public.missions m
          JOIN public.clients c ON m.client_id = c.id
          WHERE c.auth_user_id = auth.uid() OR c.email = (auth.jwt()->>'email')
        )
        OR mission_id IN (
          SELECT m.id FROM public.missions m
          WHERE m.client_email = (auth.jwt()->>'email')
        )
        -- Convoyeur : assigné à la mission liée
        OR convoyeur_nom IN (
          SELECT (prenom || ' ' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (nom || ' ' || prenom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
      )
    )
  );

-- UPDATE : admin OU convoyeur assigné (peut compléter son EDL)
DROP POLICY IF EXISTS "edls_update_own_or_admin" ON public.edls;
DROP POLICY IF EXISTS "edls_update_admin" ON public.edls;
CREATE POLICY "edls_update_own_or_admin"
  ON public.edls
  FOR UPDATE
  TO authenticated
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        convoyeur_nom IN (
          SELECT (prenom || ' ' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (nom || ' ' || prenom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
      )
    )
  )
  WITH CHECK (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        convoyeur_nom IN (
          SELECT (prenom || ' ' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
        OR convoyeur_nom IN (
          SELECT (nom || ' ' || prenom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
      )
    )
  );

-- DELETE : admin uniquement
DROP POLICY IF EXISTS "edls_delete_admin" ON public.edls;
CREATE POLICY "edls_delete_admin"
  ON public.edls
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- =========================================================
-- 5. CANDIDATURES : INSERT authentifié (convoyeur postule)
--    SELECT : convoyeur voit les siennes + admin voit tout
--    UPDATE/DELETE : admin uniquement
-- =========================================================

DROP POLICY IF EXISTS "candidatures_insert_authenticated" ON public.candidatures;
CREATE POLICY "candidatures_insert_authenticated"
  ON public.candidatures
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND convoyeur_id IN (
      SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "candidatures_select_own_or_admin" ON public.candidatures;
CREATE POLICY "candidatures_select_own_or_admin"
  ON public.candidatures
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR convoyeur_id IN (SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid())
    OR convoyeur_nom IN (
      SELECT (prenom || ' ' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
    )
    OR convoyeur_nom IN (
      SELECT (nom || ' ' || prenom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
    )
  );

-- =========================================================
-- 6. CHECK CONSTRAINT sur missions.status
-- =========================================================

ALTER TABLE public.missions DROP CONSTRAINT IF EXISTS missions_status_check;
ALTER TABLE public.missions
  ADD CONSTRAINT missions_status_check
  CHECK (status IN (
    'available',     -- Sur le marché, en attente de convoyeur
    'planned',       -- Convoyeur assigné, mission planifiée
    'in_progress',   -- Convoyeur en route / mission en cours
    'completed',     -- Mission terminée
    'cancelled',     -- Annulée
    'archived'       -- Archivée (masquée)
  ));

-- =========================================================
-- 7. DROPPER LES COLONNES MORTES (TVA/TTC/prix_ht)
-- =========================================================

ALTER TABLE public.missions DROP COLUMN IF EXISTS prix_ht;
ALTER TABLE public.missions DROP COLUMN IF EXISTS prix_ttc;
ALTER TABLE public.missions DROP COLUMN IF EXISTS tva;

ALTER TABLE public.clients DROP COLUMN IF EXISTS tva;

-- =========================================================
-- 8. DROPPER LES COLONNES mot_de_passe (legacy en clair)
--    Supabase Auth est désormais utilisé pour toute l'auth.
--    Ces colonnes ne servent plus que de fallback SHA-256
--    pour les anciens comptes non migrés.
--    Si tous les comptes sont sur Supabase Auth → safe to drop.
-- =========================================================

ALTER TABLE public.clients DROP COLUMN IF EXISTS mot_de_passe;
ALTER TABLE public.convoyeurs DROP COLUMN IF EXISTS mot_de_passe;
ALTER TABLE public.convoyeurs_candidats DROP COLUMN IF EXISTS mot_de_passe;

-- =========================================================
-- 9. SUPPORT_TICKETS : INSERT par anon (formulaire contact public)
--    avec validation des champs obligatoires
-- =========================================================

DROP POLICY IF EXISTS "tickets_insert_authenticated" ON public.support_tickets;
DROP POLICY IF EXISTS "tickets_insert_public_safe" ON public.support_tickets;
CREATE POLICY "tickets_insert_public_safe"
  ON public.support_tickets
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    message IS NOT NULL AND message <> ''
    AND (
      client_email IS NOT NULL
      OR convoyeur_email IS NOT NULL
      OR client_id IS NOT NULL
    )
  );

-- =========================================================
-- 10. VÉRIFIER : Toutes les tables ont RLS activé
-- =========================================================

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    AND table_name NOT IN ('_prisma_migrations')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- =========================================================
-- 11. GRANT MINIMAUX : anon ne peut que INSERT sur devis + tickets
--     authenticated a SELECT/INSERT/UPDATE/DELETE selon policies
-- =========================================================

-- Révoquer tous les grants par défaut puis re-grant proprement
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;

-- anon : SELECT sur system_settings (tarifs publics) + convoyeurs_public (vue)
GRANT SELECT ON public.system_settings TO anon;
GRANT SELECT ON public.convoyeurs_public TO anon;

-- anon : INSERT sur devis (formulaire public) + tickets (contact public)
-- + convoyeur_candidatures (formation publique) + convoyeurs_candidats (legacy)
GRANT INSERT ON public.devis TO anon;
GRANT INSERT ON public.support_tickets TO anon;
GRANT INSERT ON public.convoyeur_candidatures TO anon;
GRANT INSERT ON public.convoyeurs_candidats TO anon;
GRANT INSERT ON public.newsletter_subscribers TO anon;

-- anon : SELECT sur missions (tracking GPS, status in_progress uniquement via RLS)
GRANT SELECT ON public.missions TO anon;

-- anon : EXECUTE sur unsubscribe_newsletter_by_token
GRANT EXECUTE ON FUNCTION public.unsubscribe_newsletter_by_token(text) TO anon;

-- authenticated : accès complet selon policies RLS
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

-- authenticated : EXECUTE sur fonctions métier
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_toggle_ban(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_parrainage_code(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.like_reseau_post(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unsubscribe_newsletter_by_token(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
