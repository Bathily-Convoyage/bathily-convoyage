-- =====================================================
-- Migration 029 : Correction admin_delete_user
-- La fonction utilisait convoyeur_nom au lieu de convoyeur_id
-- pour dissocier les missions (Bug 15)
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
    -- Dissocier les missions
    UPDATE public.missions SET client_id = NULL WHERE client_id = target_id;
    -- Supprimer les tickets
    DELETE FROM public.support_tickets WHERE client_id = target_id;
    -- Supprimer le client
    DELETE FROM public.clients WHERE id = target_id;
  ELSIF target_table = 'convoyeurs' THEN
    -- Dissocier les missions via convoyeur_id (plus fiable que convoyeur_nom)
    UPDATE public.missions
      SET convoyeur_nom = NULL, convoyeur_id = NULL, status = 'available'
      WHERE convoyeur_id = target_id;

    -- Supprimer les candidatures liées
    DELETE FROM public.candidatures WHERE convoyeur_id = target_id;

    -- Supprimer le convoyeur
    DELETE FROM public.convoyeurs WHERE id = target_id;
  ELSE
    RAISE EXCEPTION 'Table non supportée : %', target_table;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
