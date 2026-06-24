-- =====================================================
-- Migration 024 : Correction fonction admin_delete_user
-- La fonction référençait convoyeur_id qui n'existe pas dans missions
-- =====================================================

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
    -- Récupérer le nom complet du convoyeur
    DECLARE
      nom_complet text;
    BEGIN
      SELECT (prenom || ' ' || nom) INTO nom_complet
      FROM public.convoyeurs WHERE id = target_id;

      -- Remettre les missions sur le marché (par nom, pas par convoyeur_id)
      UPDATE public.missions SET convoyeur_nom = NULL, statut = 'available'
        WHERE convoyeur_nom = nom_complet;

      -- Supprimer les candidatures
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
