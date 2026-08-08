-- Migration 025: Fix edls schema (add missing columns) and RLS (allow convoyeur SELECT)

-- 1. Add missing columns that etat-des-lieux.html inserts
ALTER TABLE public.edls
  ADD COLUMN IF NOT EXISTS equipements jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS mecanique jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS remarques_techniques text;

-- 2. Fix RLS: allow convoyeur to see their own EDLs (by convoyeur_nom)
DROP POLICY IF EXISTS "edls_select_own_or_admin" ON public.edls;
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
    OR (
      auth.uid() IS NOT NULL
      AND convoyeur_nom IN (
        SELECT (prenom || ' ' || nom) FROM public.convoyeurs
        WHERE auth_user_id = auth.uid()
      )
    )
  );

NOTIFY pgrst, 'reload schema';

-- 3. Fix admin_delete_user: statut -> status
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
    UPDATE public.missions SET client_id = NULL WHERE client_id = target_id;
    DELETE FROM public.vehicules WHERE client_id = target_id;
    DELETE FROM public.support_tickets WHERE client_id = target_id;
    DELETE FROM public.clients WHERE id = target_id;
  ELSIF target_table = 'convoyeurs' THEN
    UPDATE public.missions SET convoyeur_nom = NULL, convoyeur_id = NULL, status = 'available'
      WHERE convoyeur_id = target_id;
    DELETE FROM public.candidatures WHERE convoyeur_nom IN (
      SELECT (prenom || ' ' || nom) FROM public.convoyeurs WHERE id = target_id
    );
    DELETE FROM public.convoyeurs WHERE id = target_id;
  ELSE
    RAISE EXCEPTION 'Table non supportée : %', target_table;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
