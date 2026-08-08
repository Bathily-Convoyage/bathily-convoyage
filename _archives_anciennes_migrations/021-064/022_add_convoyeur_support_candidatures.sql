-- Migration: Add convoyeur columns to support_tickets and fix candidatures

-- 1. Add convoyeur columns to support_tickets
ALTER TABLE public.support_tickets 
  ADD COLUMN IF NOT EXISTS convoyeur_id uuid REFERENCES public.convoyeurs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS convoyeur_email text,
  ADD COLUMN IF NOT EXISTS convoyeur_nom text;

-- 2. Update support_tickets RLS to allow convoyeurs
DROP POLICY IF EXISTS "tickets_insert_authenticated" ON public.support_tickets;
DROP POLICY IF EXISTS "tickets_select_own_or_admin" ON public.support_tickets;

CREATE POLICY "tickets_insert_authenticated"
  ON public.support_tickets
  FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND (
      client_id IN (
        SELECT id FROM public.clients
        WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
      )
      OR
      convoyeur_id IN (
        SELECT id FROM public.convoyeurs
        WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
      )
    )
  );

CREATE POLICY "tickets_select_own_or_admin"
  ON public.support_tickets
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
        OR
        convoyeur_id IN (
          SELECT id FROM public.convoyeurs
          WHERE auth_user_id = auth.uid() OR email = (auth.jwt()->>'email')
        )
      )
    )
  );

-- 3. Add convoyeur_id to candidatures if missing
ALTER TABLE public.candidatures 
  ADD COLUMN IF NOT EXISTS convoyeur_id uuid REFERENCES public.convoyeurs(id) ON DELETE SET NULL;

-- 4. Add address columns to convoyeurs if missing
ALTER TABLE public.convoyeurs
  ADD COLUMN IF NOT EXISTS adresse text,
  ADD COLUMN IF NOT EXISTS code_postal text,
  ADD COLUMN IF NOT EXISTS ville text;

-- 5. Update candidatures RLS to allow convoyeurs
DROP POLICY IF EXISTS "candidatures_insert_authenticated" ON public.candidatures;
CREATE POLICY "candidatures_insert_authenticated"
  ON public.candidatures
  FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
  );
