-- =====================================================
-- Migration 025 : Correction fonction is_admin()
-- auth.jwt()->>'email' peut etre null meme pour un user authentifie
-- Solution robuste : utiliser uniquement auth.uid() + auth_user_id
-- =====================================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.clients c
    WHERE c.role = 'admin'
      AND c.auth_user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

-- Mettre a jour la policy SELECT sur clients
DROP POLICY IF EXISTS "clients_select_own_or_admin" ON public.clients;

CREATE POLICY "clients_select_own_or_admin"
  ON public.clients
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin())
    OR auth.uid() = auth_user_id
  );

NOTIFY pgrst, 'reload schema';
