-- Migration: Lier automatiquement les missions existantes au nouveau client lors de son inscription
-- Ceci permet de s'assurer qu'un client retrouve ses missions passées (faites via des devis publics)
-- une fois qu'il a créé son compte, contournant ainsi le blocage RLS.

-- 1. Fonction du trigger
CREATE OR REPLACE FUNCTION public.auto_link_missions_to_client()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER -- S'exécute avec les privilèges de l'admin (bypasse le RLS)
AS $$
BEGIN
  -- Met à jour toutes les missions où l'email correspond au nouvel inscrit
  -- et dont le client_id n'a pas encore été affecté.
  UPDATE public.missions
  SET client_id = NEW.id
  WHERE client_email = NEW.email
    AND client_id IS NULL;

  RETURN NEW;
END;
$$;

-- 2. Création du trigger sur la table clients
DROP TRIGGER IF EXISTS trg_auto_link_missions ON public.clients;
CREATE TRIGGER trg_auto_link_missions
AFTER INSERT ON public.clients
FOR EACH ROW
EXECUTE FUNCTION public.auto_link_missions_to_client();
