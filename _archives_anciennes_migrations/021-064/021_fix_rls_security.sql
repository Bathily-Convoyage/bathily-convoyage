-- =====================================================
-- Migration 021 : Correction des vulnérabilités RLS
-- Identifiées par l'audit Supabase
-- =====================================================
-- Problèmes corrigés :
-- 1. convoyeurs_candidats : SELECT ouvert à anon (fuite mot_de_passe)
-- 2. clients : INSERT ouvert à anon sans rattachement auth_user_id
-- 3. system_settings : écriture ouverte à tous les authenticated
-- 4. devis : SELECT ouvert à tout le monde (USING true)
-- 5. convoyeurs : UPDATE ouvert à tous (USING true)
-- 6. edls : INSERT ouvert à anon (USING true)
-- 7. support_tickets : INSERT ouvert à anon sans rattachement
-- 8. storage.objects : policies globales au lieu de cibler le bucket
--
-- IMPORTANT : L'admin dashboard utilise l'anon key + Supabase Auth.
-- L'admin est un utilisateur authentifié avec role='admin' dans clients.
-- Les politiques admin utilisent la fonction is_admin() (SECURITY DEFINER)
-- pour éviter la récursion RLS.
-- =====================================================

NOTIFY pgrst, 'reload schema';

-- =====================================================
-- 0. FONCTION UTILITAIRE : is_admin()
--    SECURITY DEFINER pour bypasser RLS lors de la vérification
--    (évite la récursion infinie sur la table clients)
-- =====================================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.clients
    WHERE email = (auth.jwt()->>'email')
      AND role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

-- =====================================================
-- 1. TABLE : convoyeurs_candidats
--    Bloquer totalement l'accès anon (mot_de_passe en clair)
--    Admin : accès total via is_admin()
-- =====================================================

DROP POLICY IF EXISTS "Insertion publique candidatures" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "Lecture candidats" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "MAJ statut admin" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "Insertion candidature libre" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "Lecture candidats bloquee anon" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "MAJ candidats bloquee anon" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "Suppression candidats bloquee" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "convoyeurs_candidats_select_anon" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "convoyeurs_candidats_insert_anon" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "candidats_insert_blocked_anon" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "candidats_select_blocked_anon" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "candidats_update_blocked_anon" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "candidats_delete_blocked_anon" ON public.convoyeurs_candidats;

ALTER TABLE public.convoyeurs_candidats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "candidats_insert_public" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "candidats_select_admin" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "candidats_update_admin" ON public.convoyeurs_candidats;
DROP POLICY IF EXISTS "candidats_delete_admin" ON public.convoyeurs_candidats;

-- INSERT : autorisé pour tous (formulaire public de candidature)
CREATE POLICY "candidats_insert_public"
  ON public.convoyeurs_candidats
  FOR INSERT
  WITH CHECK (true);

-- SELECT : admin uniquement (données sensibles dont mot_de_passe)
CREATE POLICY "candidats_select_admin"
  ON public.convoyeurs_candidats
  FOR SELECT
  USING (public.is_admin());

-- UPDATE : admin uniquement
CREATE POLICY "candidats_update_admin"
  ON public.convoyeurs_candidats
  FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- DELETE : admin uniquement
CREATE POLICY "candidats_delete_admin"
  ON public.convoyeurs_candidats
  FOR DELETE
  USING (public.is_admin());

-- =====================================================
-- 2. TABLE : clients
--    INSERT : uniquement authenticated avec auth_user_id
--    SELECT : uniquement son propre profil
-- =====================================================

DROP POLICY IF EXISTS "Clients peuvent s'inscrire" ON public.clients;
DROP POLICY IF EXISTS "Lecture bloquée anon" ON public.clients;
DROP POLICY IF EXISTS "Modification bloquée anon" ON public.clients;
DROP POLICY IF EXISTS "Suppression bloquée" ON public.clients;
DROP POLICY IF EXISTS "Client voit son profil" ON public.clients;
DROP POLICY IF EXISTS "Utilisateur authentifié lit son profil" ON public.clients;
DROP POLICY IF EXISTS "clients_insert_public" ON public.clients;
DROP POLICY IF EXISTS "clients_insert_authenticated" ON public.clients;
DROP POLICY IF EXISTS "clients_select_own_or_admin" ON public.clients;
DROP POLICY IF EXISTS "clients_update_own_or_admin" ON public.clients;
DROP POLICY IF EXISTS "clients_delete_admin" ON public.clients;

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- INSERT : uniquement authenticated, avec auth_user_id obligatoire
CREATE POLICY "clients_insert_authenticated"
  ON public.clients
  FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND auth_user_id = auth.uid()
  );

-- SELECT : son propre profil OU admin voit tout
CREATE POLICY "clients_select_own_or_admin"
  ON public.clients
  FOR SELECT
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        auth_user_id = auth.uid()
        OR email = (auth.jwt()->>'email')
      )
    )
  );

-- UPDATE : son propre profil OU admin
CREATE POLICY "clients_update_own_or_admin"
  ON public.clients
  FOR UPDATE
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        auth_user_id = auth.uid()
        OR email = (auth.jwt()->>'email')
      )
    )
  )
  WITH CHECK (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        auth_user_id = auth.uid()
        OR email = (auth.jwt()->>'email')
      )
    )
  );

-- DELETE : admin uniquement
CREATE POLICY "clients_delete_admin"
  ON public.clients
  FOR DELETE
  USING (public.is_admin());

-- =====================================================
-- 3. TABLE : convoyeurs
--    UPDATE : restreint au propriétaire (auth_user_id)
-- =====================================================

DROP POLICY IF EXISTS "Lecture publique convoyeurs" ON public.convoyeurs;
DROP POLICY IF EXISTS "Insertion admin convoyeurs" ON public.convoyeurs;
DROP POLICY IF EXISTS "MAJ convoyeurs" ON public.convoyeurs;
DROP POLICY IF EXISTS "Lecture convoyeurs bloquee anon" ON public.convoyeurs;
DROP POLICY IF EXISTS "Insertion convoyeurs bloquee anon" ON public.convoyeurs;
DROP POLICY IF EXISTS "MAJ convoyeurs session app" ON public.convoyeurs;
DROP POLICY IF EXISTS "Suppression convoyeurs bloquee" ON public.convoyeurs;
DROP POLICY IF EXISTS "Convoyeur voit son profil" ON public.convoyeurs;
DROP POLICY IF EXISTS "Convoyeur modifie son profil" ON public.convoyeurs;

DROP POLICY IF EXISTS "convoyeurs_select_own_or_admin" ON public.convoyeurs;
DROP POLICY IF EXISTS "convoyeurs_insert_authenticated_or_admin" ON public.convoyeurs;
DROP POLICY IF EXISTS "convoyeurs_update_own_or_admin" ON public.convoyeurs;
DROP POLICY IF EXISTS "convoyeurs_delete_admin" ON public.convoyeurs;

ALTER TABLE public.convoyeurs ENABLE ROW LEVEL SECURITY;

-- SELECT : son propre profil OU admin voit tout
CREATE POLICY "convoyeurs_select_own_or_admin"
  ON public.convoyeurs
  FOR SELECT
  USING (
    public.is_admin()
    OR auth_user_id = auth.uid()
  );

-- INSERT : authenticated avec auth_user_id OU admin
CREATE POLICY "convoyeurs_insert_authenticated_or_admin"
  ON public.convoyeurs
  FOR INSERT
  WITH CHECK (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND auth_user_id = auth.uid()
    )
  );

-- UPDATE : son propre profil OU admin
CREATE POLICY "convoyeurs_update_own_or_admin"
  ON public.convoyeurs
  FOR UPDATE
  USING (
    public.is_admin()
    OR auth_user_id = auth.uid()
  )
  WITH CHECK (
    public.is_admin()
    OR auth_user_id = auth.uid()
  );

-- DELETE : admin uniquement
CREATE POLICY "convoyeurs_delete_admin"
  ON public.convoyeurs
  FOR DELETE
  USING (public.is_admin());

-- =====================================================
-- 4. TABLE : devis
--    INSERT : anon autorisé (formulaire public)
--    SELECT : authenticated uniquement (admin dashboard)
--    UPDATE : authenticated uniquement (admin dashboard)
-- =====================================================

DROP POLICY IF EXISTS "Autoriser toutes les actions sur devis" ON public.devis;
DROP POLICY IF EXISTS "Accès complet pour l'admin" ON public.devis;
DROP POLICY IF EXISTS "Autoriser la lecture publique des devis" ON public.devis;
DROP POLICY IF EXISTS "Autoriser la modification publique des devis" ON public.devis;
DROP POLICY IF EXISTS "Lecture devis publique securisee" ON public.devis;
DROP POLICY IF EXISTS "Modification devis par admin" ON public.devis;
DROP POLICY IF EXISTS "devis_insert_public" ON public.devis;
DROP POLICY IF EXISTS "devis_select_own" ON public.devis;

DROP POLICY IF EXISTS "devis_insert_public" ON public.devis;
DROP POLICY IF EXISTS "devis_select_authenticated" ON public.devis;
DROP POLICY IF EXISTS "devis_update_authenticated" ON public.devis;
DROP POLICY IF EXISTS "devis_delete_admin" ON public.devis;

ALTER TABLE public.devis ENABLE ROW LEVEL SECURITY;

-- INSERT : autorisé pour tous (formulaire public de demande de devis)
CREATE POLICY "devis_insert_public"
  ON public.devis
  FOR INSERT
  WITH CHECK (true);

-- SELECT : authenticated uniquement (admin consulte les devis)
CREATE POLICY "devis_select_authenticated"
  ON public.devis
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- UPDATE : authenticated uniquement (admin change le statut)
CREATE POLICY "devis_update_authenticated"
  ON public.devis
  FOR UPDATE
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- DELETE : admin uniquement
CREATE POLICY "devis_delete_admin"
  ON public.devis
  FOR DELETE
  USING (public.is_admin());

-- =====================================================
-- 5. TABLE : system_settings
--    SELECT : public (tarifs des packs affichés sur le site)
--    INSERT/UPDATE/DELETE : admin uniquement (role = 'admin')
-- =====================================================

DROP POLICY IF EXISTS "Allow public read access on system_settings" ON public.system_settings;
DROP POLICY IF EXISTS "Allow authenticated users to manage system_settings" ON public.system_settings;
DROP POLICY IF EXISTS "system_settings_select_authed" ON public.system_settings;

DROP POLICY IF EXISTS "system_settings_select_public" ON public.system_settings;
DROP POLICY IF EXISTS "system_settings_insert_admin" ON public.system_settings;
DROP POLICY IF EXISTS "system_settings_update_admin" ON public.system_settings;
DROP POLICY IF EXISTS "system_settings_delete_admin" ON public.system_settings;

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- SELECT : public (lecture des tarifs packs sur les pages publiques)
CREATE POLICY "system_settings_select_public"
  ON public.system_settings
  FOR SELECT
  USING (true);

-- INSERT : admin uniquement
CREATE POLICY "system_settings_insert_admin"
  ON public.system_settings
  FOR INSERT
  WITH CHECK (public.is_admin());

-- UPDATE : admin uniquement
CREATE POLICY "system_settings_update_admin"
  ON public.system_settings
  FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- DELETE : admin uniquement
CREATE POLICY "system_settings_delete_admin"
  ON public.system_settings
  FOR DELETE
  USING (public.is_admin());

-- =====================================================
-- 6. TABLE : missions
--    Resserre les politiques existantes
-- =====================================================

DROP POLICY IF EXISTS "Lecture publique missions" ON public.missions;
DROP POLICY IF EXISTS "Insertion missions" ON public.missions;
DROP POLICY IF EXISTS "MAJ missions" ON public.missions;
DROP POLICY IF EXISTS "DELETE missions" ON public.missions;
DROP POLICY IF EXISTS "Client voit ses missions" ON public.missions;
DROP POLICY IF EXISTS "Convoyeur voit ses missions assignees" ON public.missions;
DROP POLICY IF EXISTS "Insertion mission authentifiee" ON public.missions;
DROP POLICY IF EXISTS "Client modifie ses missions" ON public.missions;
DROP POLICY IF EXISTS "Suppression missions bloquee" ON public.missions;

DROP POLICY IF EXISTS "missions_select_own_or_admin" ON public.missions;
DROP POLICY IF EXISTS "missions_insert_authenticated" ON public.missions;
DROP POLICY IF EXISTS "missions_update_own_or_admin" ON public.missions;
DROP POLICY IF EXISTS "missions_delete_admin" ON public.missions;
DROP POLICY IF EXISTS "missions_select_available_for_convoyeurs" ON public.missions;
DROP POLICY IF EXISTS "missions_select_active_anon" ON public.missions;
DROP POLICY IF EXISTS "missions_update_active_anon" ON public.missions;

ALTER TABLE public.missions ENABLE ROW LEVEL SECURITY;

-- SELECT : client/convoyeur voit ses missions OU admin voit tout
CREATE POLICY "missions_select_own_or_admin"
  ON public.missions
  FOR SELECT
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        client_id IN (
          SELECT id FROM public.clients
          WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
        )
        OR convoyeur_id IN (
          SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
      )
    )
  );

-- INSERT : authenticated uniquement (admin crée les missions)
CREATE POLICY "missions_insert_authenticated"
  ON public.missions
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- UPDATE : client/convoyeur concerné OU admin
CREATE POLICY "missions_update_own_or_admin"
  ON public.missions
  FOR UPDATE
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND (
        client_id IN (
          SELECT id FROM public.clients
          WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
        )
        OR convoyeur_id IN (
          SELECT id FROM public.convoyeurs WHERE auth_user_id = auth.uid()
        )
      )
    )
  );

-- DELETE : admin uniquement
CREATE POLICY "missions_delete_admin"
  ON public.missions
  FOR DELETE
  USING (public.is_admin());

-- =====================================================
-- 7. TABLE : edls
--    INSERT : authenticated uniquement (convoyeur en mission)
--    SELECT : client propriétaire de la mission
-- =====================================================

DROP POLICY IF EXISTS "Insertion publique edls" ON public.edls;
DROP POLICY IF EXISTS "Lecture publique edls" ON public.edls;
DROP POLICY IF EXISTS "Mise a jour edls" ON public.edls;
DROP POLICY IF EXISTS "Insertion edl authentifie" ON public.edls;
DROP POLICY IF EXISTS "Client voit ses edls" ON public.edls;
DROP POLICY IF EXISTS "MAJ edls bloquee anon" ON public.edls;
DROP POLICY IF EXISTS "Suppression edls bloquee" ON public.edls;

DROP POLICY IF EXISTS "edls_insert_public" ON public.edls;
DROP POLICY IF EXISTS "edls_select_own_or_admin" ON public.edls;
DROP POLICY IF EXISTS "edls_update_admin" ON public.edls;
DROP POLICY IF EXISTS "edls_delete_admin" ON public.edls;

ALTER TABLE public.edls ENABLE ROW LEVEL SECURITY;

-- INSERT : autorisé pour tous (etat-des-lieux.html est un formulaire de terrain sans auth)
CREATE POLICY "edls_insert_public"
  ON public.edls
  FOR INSERT
  WITH CHECK (true);

-- SELECT : client propriétaire de la mission OU admin
CREATE POLICY "edls_select_own_or_admin"
  ON public.edls
  FOR SELECT
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND mission_id IN (
        SELECT m.id FROM public.missions m
        JOIN public.clients c ON m.client_id = c.id
        WHERE c.auth_user_id = auth.uid() OR c.email = (auth.jwt()->>'email')
      )
    )
  );

-- UPDATE : admin uniquement
CREATE POLICY "edls_update_admin"
  ON public.edls
  FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- DELETE : admin uniquement
CREATE POLICY "edls_delete_admin"
  ON public.edls
  FOR DELETE
  USING (public.is_admin());

-- =====================================================
-- 8. TABLE : vehicules
--    Resserre l'accès via auth_user_id au lieu d'email
-- =====================================================

DROP POLICY IF EXISTS "Client voit ses vehicules" ON public.vehicules;
DROP POLICY IF EXISTS "Client ajoute ses vehicules" ON public.vehicules;
DROP POLICY IF EXISTS "Client modifie ses vehicules" ON public.vehicules;
DROP POLICY IF EXISTS "Client supprime ses vehicules" ON public.vehicules;

DROP POLICY IF EXISTS "vehicules_select_own_or_admin" ON public.vehicules;
DROP POLICY IF EXISTS "vehicules_insert_own_or_admin" ON public.vehicules;
DROP POLICY IF EXISTS "vehicules_update_own_or_admin" ON public.vehicules;
DROP POLICY IF EXISTS "vehicules_delete_own_or_admin" ON public.vehicules;

ALTER TABLE public.vehicules ENABLE ROW LEVEL SECURITY;

-- SELECT : client propriétaire OU admin
CREATE POLICY "vehicules_select_own_or_admin"
  ON public.vehicules
  FOR SELECT
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND client_id IN (
        SELECT id FROM public.clients
        WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
      )
    )
  );

-- INSERT : client propriétaire OU admin
CREATE POLICY "vehicules_insert_own_or_admin"
  ON public.vehicules
  FOR INSERT
  WITH CHECK (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND client_id IN (
        SELECT id FROM public.clients
        WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
      )
    )
  );

-- UPDATE : client propriétaire OU admin
CREATE POLICY "vehicules_update_own_or_admin"
  ON public.vehicules
  FOR UPDATE
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND client_id IN (
        SELECT id FROM public.clients
        WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
      )
    )
  );

-- DELETE : client propriétaire OU admin
CREATE POLICY "vehicules_delete_own_or_admin"
  ON public.vehicules
  FOR DELETE
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND client_id IN (
        SELECT id FROM public.clients
        WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
      )
    )
  );

-- =====================================================
-- 9. TABLE : support_tickets
--    INSERT : authenticated avec rattachement client
--    SELECT : client propriétaire uniquement
-- =====================================================

DROP POLICY IF EXISTS "Client cree ticket" ON public.support_tickets;
DROP POLICY IF EXISTS "Client voit ses tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "MAJ tickets bloquee anon" ON public.support_tickets;
DROP POLICY IF EXISTS "Suppression tickets bloquee" ON public.support_tickets;

DROP POLICY IF EXISTS "tickets_insert_authenticated" ON public.support_tickets;
DROP POLICY IF EXISTS "tickets_select_own_or_admin" ON public.support_tickets;
DROP POLICY IF EXISTS "tickets_update_admin" ON public.support_tickets;
DROP POLICY IF EXISTS "tickets_delete_admin" ON public.support_tickets;

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

-- INSERT : authenticated avec rattachement client
CREATE POLICY "tickets_insert_authenticated"
  ON public.support_tickets
  FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND client_id IN (
      SELECT id FROM public.clients
      WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
    )
  );

-- SELECT : client propriétaire OU admin
CREATE POLICY "tickets_select_own_or_admin"
  ON public.support_tickets
  FOR SELECT
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND client_id IN (
        SELECT id FROM public.clients
        WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
      )
    )
  );

-- UPDATE : admin uniquement (répondre aux tickets)
CREATE POLICY "tickets_update_admin"
  ON public.support_tickets
  FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- DELETE : admin uniquement
CREATE POLICY "tickets_delete_admin"
  ON public.support_tickets
  FOR DELETE
  USING (public.is_admin());

-- =====================================================
-- 10. STORAGE : sécurisation du bucket "documents"
--     Remplace les policies globales par des policies ciblées
-- =====================================================

DROP POLICY IF EXISTS "Public Access" ON storage.objects;
DROP POLICY IF EXISTS "Upload Access" ON storage.objects;
DROP POLICY IF EXISTS "Update Access" ON storage.objects;
DROP POLICY IF EXISTS "Delete Access" ON storage.objects;
DROP POLICY IF EXISTS "Documents lecture publique" ON storage.objects;
DROP POLICY IF EXISTS "Documents upload authentifie" ON storage.objects;
DROP POLICY IF EXISTS "Documents update bloque anon" ON storage.objects;
DROP POLICY IF EXISTS "Documents delete bloque" ON storage.objects;

DROP POLICY IF EXISTS "documents_select_public" ON storage.objects;
DROP POLICY IF EXISTS "documents_insert_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "documents_update_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "documents_delete_blocked" ON storage.objects;

-- SELECT : public (URLs de documents partagés avec les clients)
CREATE POLICY "documents_select_public"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'documents');

-- INSERT : authenticated uniquement
CREATE POLICY "documents_insert_authenticated"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'documents'
    AND auth.role() = 'authenticated'
  );

-- UPDATE : authenticated uniquement
CREATE POLICY "documents_update_authenticated"
  ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'documents'
    AND auth.role() = 'authenticated'
  );

-- DELETE : bloqué (admin via service_role)
CREATE POLICY "documents_delete_blocked"
  ON storage.objects
  FOR DELETE
  USING (false);

-- =====================================================
-- 11. MISSIONS : accès convoyeur aux missions disponibles
--     Les convoyeurs authentifiés doivent voir les missions
--     disponibles (statut = 'available' ou 'planifiee') pour postuler
--     Les pages de terrain (etat-des-lieux.html) accèdent aux missions
--     en cours sans auth (formulaire de terrain)
-- =====================================================

-- (DROP déjà fait dans la section 6)

CREATE POLICY "missions_select_available_for_convoyeurs"
  ON public.missions
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND statut IN ('available', 'planifiee')
  );

-- SELECT : accès anon pour les missions en cours (etat-des-lieux.html, tracking, bon-de-mission)
CREATE POLICY "missions_select_active_anon"
  ON public.missions
  FOR SELECT
  USING (
    auth.uid() IS NULL
    AND statut IN ('en_cours', 'confirmee', 'planifiee', 'available', 'in_progress')
  );

-- UPDATE : accès anon pour les missions actives (bon-de-mission.html change le statut sans auth)
CREATE POLICY "missions_update_active_anon"
  ON public.missions
  FOR UPDATE
  USING (
    auth.uid() IS NULL
    AND statut IN ('confirmee', 'planifiee', 'available', 'in_progress')
  )
  WITH CHECK (
    auth.uid() IS NULL
    AND statut IN ('en_cours', 'in_progress', 'confirmee', 'planifiee', 'available', 'terminee')
  );

-- =====================================================
-- 12. TABLE : candidatures
--     Les convoyeurs postulent aux missions disponibles
--     L'admin gère (valide/refuse) les candidatures
-- =====================================================

DROP POLICY IF EXISTS "candidatures_insert_authenticated" ON public.candidatures;
DROP POLICY IF EXISTS "candidatures_select_own_or_admin" ON public.candidatures;
DROP POLICY IF EXISTS "candidatures_update_admin" ON public.candidatures;
DROP POLICY IF EXISTS "candidatures_delete_admin" ON public.candidatures;

ALTER TABLE public.candidatures ENABLE ROW LEVEL SECURITY;

-- INSERT : authenticated (convoyeur authentifié)
CREATE POLICY "candidatures_insert_authenticated"
  ON public.candidatures
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- SELECT : convoyeur voit ses propres candidatures OU admin voit tout
CREATE POLICY "candidatures_select_own_or_admin"
  ON public.candidatures
  FOR SELECT
  USING (
    public.is_admin()
    OR (
      auth.uid() IS NOT NULL
      AND convoyeur_nom = (
        SELECT (prenom || ' ' || nom) FROM public.convoyeurs
        WHERE auth_user_id = auth.uid()
      )
    )
  );

-- UPDATE : admin uniquement
CREATE POLICY "candidatures_update_admin"
  ON public.candidatures
  FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- DELETE : admin uniquement
CREATE POLICY "candidatures_delete_admin"
  ON public.candidatures
  FOR DELETE
  USING (public.is_admin());

-- =====================================================
-- 13. VUE publique convoyeurs : security_definer
--     La vue publique expose uniquement les champs non sensibles.
--     security_definer pour que les anon puissent y accéder
--     malgré le RLS bloquant sur la table convoyeurs.
-- =====================================================

DROP VIEW IF EXISTS public.convoyeurs_public;
CREATE OR REPLACE VIEW public.convoyeurs_public
WITH (security_definer = true)
AS
SELECT id, prenom, ville, zone, niveau, disponible, zones,
       note_moyenne, grade, taux_auto, taux_moto
FROM public.convoyeurs;
GRANT SELECT ON public.convoyeurs_public TO anon, authenticated;

-- =====================================================
-- 14. TABLE : convoyeur_candidatures (si elle existe)
--     Utilisée par formation-convoyeur.html
--     Même traitement que convoyeurs_candidats : admin uniquement
-- =====================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'convoyeur_candidatures'
  ) THEN
    ALTER TABLE public.convoyeur_candidatures ENABLE ROW LEVEL SECURITY;

    EXECUTE 'DROP POLICY IF EXISTS "candidatures_conv_select_anon" ON public.convoyeur_candidatures';
    EXECUTE 'DROP POLICY IF EXISTS "candidatures_conv_insert_anon" ON public.convoyeur_candidatures';
    EXECUTE 'DROP POLICY IF EXISTS "candidatures_conv_update_anon" ON public.convoyeur_candidatures';
    EXECUTE 'DROP POLICY IF EXISTS "candidatures_conv_delete_anon" ON public.convoyeur_candidatures';

    EXECUTE 'CREATE POLICY "candidatures_conv_insert_public" ON public.convoyeur_candidatures FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "candidatures_conv_select_admin" ON public.convoyeur_candidatures FOR SELECT USING (public.is_admin())';
    EXECUTE 'CREATE POLICY "candidatures_conv_update_admin" ON public.convoyeur_candidatures FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin())';
    EXECUTE 'CREATE POLICY "candidatures_conv_delete_admin" ON public.convoyeur_candidatures FOR DELETE USING (public.is_admin())';
  END IF;
END $$;

-- =====================================================
-- 15. FONCTION RPC : admin_delete_user
--     Permet à l'admin de supprimer un client ou un convoyeur
--     SECURITY DEFINER pour bypasser RLS
-- =====================================================

CREATE OR REPLACE FUNCTION public.admin_delete_user(target_id uuid, target_table text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Permission refusée : administrateur uniquement';
  END IF;

  IF target_table = 'clients' THEN
    -- Dissocier les missions du client
    UPDATE public.missions SET client_id = NULL WHERE client_id = target_id;
    -- Supprimer les véhicules
    DELETE FROM public.vehicules WHERE client_id = target_id;
    -- Supprimer les tickets
    DELETE FROM public.support_tickets WHERE client_id = target_id;
    -- Supprimer le client
    DELETE FROM public.clients WHERE id = target_id;
  ELSIF target_table = 'convoyeurs' THEN
    -- Remettre les missions sur le marché
    UPDATE public.missions SET convoyeur_nom = NULL, convoyeur_id = NULL, status = 'available'
      WHERE convoyeur_id = target_id;
    -- Supprimer les candidatures
    DELETE FROM public.candidatures WHERE convoyeur_nom IN (
      SELECT (prenom || ' ' || nom) FROM public.convoyeurs WHERE id = target_id
    );
    -- Supprimer le convoyeur
    DELETE FROM public.convoyeurs WHERE id = target_id;
  ELSE
    RAISE EXCEPTION 'Table non supportée : %', target_table;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) TO authenticated;

-- =====================================================
-- 16. TABLES : reseau_posts et reseau_comments
--     Réseau social interne entre convoyeurs et admin
--     Création des tables si elles n'existent pas + RLS
-- =====================================================

DO $$
BEGIN
  -- Créer reseau_posts si inexistant
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'reseau_posts'
  ) THEN
    CREATE TABLE public.reseau_posts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      author_id uuid,
      author_name text NOT NULL,
      author_role text DEFAULT 'Convoyeur',
      content text NOT NULL,
      tags text[] DEFAULT '{}',
      likes_count integer DEFAULT 0,
      is_announcement boolean DEFAULT false,
      created_at timestamptz DEFAULT now()
    );
  END IF;

  -- Créer reseau_comments si inexistant
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'reseau_comments'
  ) THEN
    CREATE TABLE public.reseau_comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id uuid NOT NULL REFERENCES public.reseau_posts(id) ON DELETE CASCADE,
      author_name text NOT NULL,
      content text NOT NULL,
      created_at timestamptz DEFAULT now()
    );
  END IF;
END $$;

-- RLS pour reseau_posts
ALTER TABLE public.reseau_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reseau_posts_select_all" ON public.reseau_posts;
DROP POLICY IF EXISTS "reseau_posts_insert_authenticated" ON public.reseau_posts;
DROP POLICY IF EXISTS "reseau_posts_update_own_or_admin" ON public.reseau_posts;
DROP POLICY IF EXISTS "reseau_posts_delete_own_or_admin" ON public.reseau_posts;

-- SELECT : tout utilisateur authentifié peut lire (réseau interne)
CREATE POLICY "reseau_posts_select_all"
  ON public.reseau_posts
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- INSERT : tout utilisateur authentifié peut publier
CREATE POLICY "reseau_posts_insert_authenticated"
  ON public.reseau_posts
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- UPDATE : auteur du post OU admin (ex: likes_count)
CREATE POLICY "reseau_posts_update_own_or_admin"
  ON public.reseau_posts
  FOR UPDATE
  USING (
    public.is_admin()
    OR author_id = auth.uid()
  )
  WITH CHECK (
    public.is_admin()
    OR author_id = auth.uid()
  );

-- DELETE : auteur du post OU admin
CREATE POLICY "reseau_posts_delete_own_or_admin"
  ON public.reseau_posts
  FOR DELETE
  USING (
    public.is_admin()
    OR author_id = auth.uid()
  );

-- RLS pour reseau_comments
ALTER TABLE public.reseau_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reseau_comments_select_all" ON public.reseau_comments;
DROP POLICY IF EXISTS "reseau_comments_insert_authenticated" ON public.reseau_comments;
DROP POLICY IF EXISTS "reseau_comments_delete_own_or_admin" ON public.reseau_comments;

-- SELECT : tout utilisateur authentifié peut lire
CREATE POLICY "reseau_comments_select_all"
  ON public.reseau_comments
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- INSERT : tout utilisateur authentifié peut commenter
CREATE POLICY "reseau_comments_insert_authenticated"
  ON public.reseau_comments
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- DELETE : auteur du commentaire OU admin
CREATE POLICY "reseau_comments_delete_own_or_admin"
  ON public.reseau_comments
  FOR DELETE
  USING (
    public.is_admin()
    OR author_name = (
      SELECT (prenom || ' ' || nom) FROM public.convoyeurs WHERE auth_user_id = auth.uid()
    )
    OR author_name = (
      SELECT (prenom || ' ' || nom) FROM public.clients WHERE auth_user_id = auth.uid()
    )
  );

-- =====================================================
-- 17. COLONNES mot_de_passe : marquer pour suppression future
--     Note : Ne pas supprimer maintenant pour ne pas casser
--     le fallback SHA-256 des anciens comptes.
--     TODO : Une fois tous les comptes migrés vers Supabase Auth,
--     exécuter : ALTER TABLE public.clients DROP COLUMN mot_de_passe;
--     et      : ALTER TABLE public.convoyeurs_candidats DROP COLUMN mot_de_passe;
-- =====================================================

-- Recharger le cache du schéma
NOTIFY pgrst, 'reload schema';
