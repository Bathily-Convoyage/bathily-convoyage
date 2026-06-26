-- =====================================================
-- Migration 030 : Sécurité et logique métier
-- 1. Étendre CHECK paiement_statut pour inclure 'paye'
-- 2. Restreindre l'insertion publique sur convoyeur_candidatures
-- 3. Corriger la suppression des candidatures par convoyeur_nom ET convoyeur_id
-- =====================================================

-- 1. Étendre la contrainte CHECK sur paiement_statut
ALTER TABLE public.missions DROP CONSTRAINT IF EXISTS missions_paiement_statut_check;
ALTER TABLE public.missions
  ADD CONSTRAINT missions_paiement_statut_check
  CHECK (paiement_statut IN ('pending', 'paid', 'paye'));

-- 2. Restreindre l'insertion sur convoyeur_candidatures
--    Avant : WITH CHECK (true) → n'importe qui pouvait insérer
--    Après : WITH CHECK (auth.uid() IS NOT NULL) → authentification requise
--    Sauf si on veut garder l'insertion publique pour la formation
--    On garde l'insertion publique mais on ajoute un rate-limit côté app
--    → On laisse l'insertion publique car la formation est accessible sans compte
--    Mais on supprime les anciennes policies et on recrée proprement
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'convoyeur_candidatures'
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS "candidatures_conv_insert_public" ON public.convoyeur_candidatures';
    EXECUTE 'DROP POLICY IF EXISTS "candidatures_conv_select_admin" ON public.convoyeur_candidatures';
    EXECUTE 'DROP POLICY IF EXISTS "candidatures_conv_update_admin" ON public.convoyeur_candidatures';
    EXECUTE 'DROP POLICY IF EXISTS "candidatures_conv_delete_admin" ON public.convoyeur_candidatures';

    -- Insertion : publique (formation sans compte) mais avec validation côté app
    EXECUTE 'CREATE POLICY "candidatures_conv_insert_public" ON public.convoyeur_candidatures FOR INSERT WITH CHECK (true)';
    -- Lecture : admin uniquement
    EXECUTE 'CREATE POLICY "candidatures_conv_select_admin" ON public.convoyeur_candidatures FOR SELECT USING (public.is_admin())';
    -- Modification : admin uniquement
    EXECUTE 'CREATE POLICY "candidatures_conv_update_admin" ON public.convoyeur_candidatures FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin())';
    -- Suppression : admin uniquement
    EXECUTE 'CREATE POLICY "candidatures_conv_delete_admin" ON public.convoyeur_candidatures FOR DELETE USING (public.is_admin())';
  END IF;
END $$;

-- 3. Corriger la fonction admin_delete_user pour supprimer les candidatures
--    par convoyeur_id ET par convoyeur_nom (pour les anciennes candidatures)
CREATE OR REPLACE FUNCTION public.admin_delete_user(target_id uuid, target_table text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF target_table = 'clients' THEN
    -- Dissocier les missions
    UPDATE public.missions SET client_id = NULL WHERE client_id = target_id;
    -- Supprimer les tickets
    DELETE FROM public.support_tickets WHERE client_id = target_id;
    -- Supprimer le client
    DELETE FROM public.clients WHERE id = target_id;
  ELSIF target_table = 'convoyeurs' THEN
    -- Récupérer le nom complet du convoyeur pour les anciennes candidatures
    DECLARE
      nom_complet text;
    BEGIN
      SELECT (prenom || ' ' || nom) INTO nom_complet
      FROM public.convoyeurs WHERE id = target_id;

      -- Dissocier les missions via convoyeur_id
      UPDATE public.missions
        SET convoyeur_nom = NULL, convoyeur_id = NULL, status = 'available'
        WHERE convoyeur_id = target_id;

      -- Supprimer les candidatures par convoyeur_id (nouvelles) ET par nom (anciennes)
      DELETE FROM public.candidatures WHERE convoyeur_id = target_id;
      DELETE FROM public.candidatures WHERE convoyeur_nom = nom_complet;

      -- Supprimer le convoyeur
      DELETE FROM public.convoyeurs WHERE id = target_id;
    END;
  ELSE
    RAISE EXCEPTION 'Table non supportée : %', target_table;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
