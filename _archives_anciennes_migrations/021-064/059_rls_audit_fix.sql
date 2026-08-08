-- =====================================================
-- Migration 059 : Audit RLS — correctifs post-audit
-- =====================================================
-- Problèmes corrigés :
-- 1. newsletter_subscribers : les anonymes ne pouvaient plus se désinscrire (049 a supprimé l'UPDATE public).
-- 2. parrainages : un filleul ne pouvait pas lire la ligne 'en_attente' pour appliquer un code.
-- 3. convoyeur_candidatures : un candidat ne pouvait pas voir sa propre candidature au login.
-- 4. avis : l'admin ne pouvait pas lire les avis non approuvés.
-- 5. convoyeurs/clients : un utilisateur migré avec auth_user_id NULL ne pouvait pas se reconnecter.
-- 6. reseau_posts : les likes (incrément likes_count) étaient bloqués car seul l'auteur peut UPDATE.
-- =====================================================

-- =========================================================
-- 1) newsletter_subscribers : désinscription par token unique
--    On supprime l'UPDATE anonyme permissif. Chaque abonné reçoit un
--    unsubscribe_token unique. La RPC unsubscribe_newsletter_by_token
--    ne désinscrit que si le token correspond.
-- =========================================================
DROP POLICY IF EXISTS "newsletter_update_anon_unsubscribe" ON public.newsletter_subscribers;

-- Ajout de la colonne token
ALTER TABLE public.newsletter_subscribers
ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT;

-- Générer des tokens pour les lignes existantes
UPDATE public.newsletter_subscribers
SET unsubscribe_token = gen_random_uuid()::text
WHERE unsubscribe_token IS NULL OR unsubscribe_token = '';

-- Unicité du token
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_unsubscribe_token
  ON public.newsletter_subscribers (unsubscribe_token);

-- Trigger pour générer automatiquement le token à l'insertion
CREATE OR REPLACE FUNCTION public.set_newsletter_unsubscribe_token()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.unsubscribe_token IS NULL OR NEW.unsubscribe_token = '' THEN
    NEW.unsubscribe_token := gen_random_uuid()::text;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_newsletter_token ON public.newsletter_subscribers;
CREATE TRIGGER set_newsletter_token
  BEFORE INSERT ON public.newsletter_subscribers
  FOR EACH ROW
  EXECUTE FUNCTION public.set_newsletter_unsubscribe_token();

-- RPC de désinscription par token
CREATE OR REPLACE FUNCTION public.unsubscribe_newsletter_by_token(token_input text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.newsletter_subscribers
  SET statut = 'desinscrit', updated_at = now()
  WHERE unsubscribe_token = token_input;

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.unsubscribe_newsletter_by_token(text) TO anon, authenticated;

-- =========================================================
-- 2) parrainages : RPC sécurisée pour appliquer un code
--    On supprime le SELECT permissif. Le filleul appelle la RPC
--    apply_parrainage_code(code) qui opère en SECURITY DEFINER.
-- =========================================================
DROP POLICY IF EXISTS "parrainages_select_en_attente" ON public.parrainages;

CREATE OR REPLACE FUNCTION public.apply_parrainage_code(code_input text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.parrainages%ROWTYPE;
BEGIN
  SELECT * INTO _row
  FROM public.parrainages
  WHERE code_parrain = code_input AND statut = 'en_attente'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.parrainages
  SET filleul_id = auth.uid(),
      filleul_email = (auth.jwt() ->> 'email'),
      statut = 'complete'
  WHERE id = _row.id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_parrainage_code(text) TO authenticated;

-- =========================================================
-- 3) convoyeur_candidatures : SELECT de sa propre candidature par email
-- =========================================================
DROP POLICY IF EXISTS "candidatures_conv_select_own" ON public.convoyeur_candidatures;
CREATE POLICY "candidatures_conv_select_own"
  ON public.convoyeur_candidatures
  FOR SELECT
  TO authenticated
  USING (email = (auth.jwt() ->> 'email'));

-- =========================================================
-- 4) avis : SELECT admin pour modération
-- =========================================================
DROP POLICY IF EXISTS "avis_select_admin" ON public.avis;
CREATE POLICY "avis_select_admin"
  ON public.avis
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- =========================================================
-- 5) convoyeurs / clients : SELECT par email pour migration comptes anciens
-- =========================================================
DROP POLICY IF EXISTS "convoyeurs_select_own_or_admin" ON public.convoyeurs;
CREATE POLICY "convoyeurs_select_own_or_admin"
  ON public.convoyeurs
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR auth_user_id = auth.uid()
    OR email = (auth.jwt() ->> 'email')
  );

DROP POLICY IF EXISTS "clients_select_own_or_admin" ON public.clients;
CREATE POLICY "clients_select_own_or_admin"
  ON public.clients
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR auth_user_id = auth.uid()
    OR email = (auth.jwt() ->> 'email')
  );

-- =========================================================
-- 6) reseau_posts : RPC pour liker sans modifier la policy UPDATE
-- =========================================================
CREATE OR REPLACE FUNCTION public.like_reseau_post(post_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.reseau_posts
  SET likes_count = COALESCE(likes_count, 0) + 1
  WHERE id = post_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.like_reseau_post(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
