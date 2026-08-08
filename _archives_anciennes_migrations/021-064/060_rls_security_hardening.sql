-- =====================================================
-- Migration 060 : Durcissement sécurité RLS / RPC / indexes
--    Réponse à l'audit agent Supabase
-- =====================================================
-- 1) Remplacer les policies INSERT permissives (WITH CHECK true) sur tables sensibles
-- 2) Révoquer EXECUTE PUBLIC sur les fonctions SECURITY DEFINER
-- 3) Fixer search_path = public sur les fonctions sensibles
-- 4) Ajouter les indexes manquants sur les foreign keys
-- =====================================================

-- =========================================================
-- 1) REMPLACER LES POLICIES INSERT TROP PERMISSIVES
-- =========================================================

-- --- convoyeur_candidatures : insert public mais avec email/prénom/nom obligatoires
DROP POLICY IF EXISTS "candidatures_conv_insert_public_safe" ON public.convoyeur_candidatures;
CREATE POLICY "candidatures_conv_insert_public_safe"
  ON public.convoyeur_candidatures
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    email IS NOT NULL AND email <> ''
    AND prenom IS NOT NULL AND prenom <> ''
    AND nom IS NOT NULL AND nom <> ''
  );

-- --- convoyeurs_candidats : insert public mais avec email obligatoire (table legacy)
DROP POLICY IF EXISTS "convoyeurs_candidats_insert_anon" ON public.convoyeurs_candidats;
CREATE POLICY "convoyeurs_candidats_insert_public_safe"
  ON public.convoyeurs_candidats
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    email IS NOT NULL AND email <> ''
  );

-- --- support_tickets : insert public mais avec message + contact obligatoires
DROP POLICY IF EXISTS "tickets_insert_public" ON public.support_tickets;
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
      OR convoyeur_id IS NOT NULL
    )
  );

-- =========================================================
-- 2) RÉVOQUER EXECUTE PUBLIC SUR LES FONCTIONS SECURITY DEFINER
-- =========================================================

-- Fonctions admin / sensibles : uniquement authenticated
REVOKE EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.admin_toggle_ban(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_toggle_ban(uuid, text, boolean) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_admin_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_by_email(text) TO authenticated;

-- Fonctions métier utilisateur : uniquement authenticated
REVOKE EXECUTE ON FUNCTION public.apply_parrainage_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_parrainage_code(text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.like_reseau_post(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.like_reseau_post(uuid) TO authenticated;

-- Fonctions publiques : anon + authenticated
REVOKE EXECUTE ON FUNCTION public.unsubscribe_newsletter_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unsubscribe_newsletter_by_token(text) TO anon, authenticated;

-- is_admin doit rester accessible à anon et authenticated (utilisé par les policies RLS)
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

-- Fonctions triggers / internes : révoquer PUBLIC, pas besoin de grant explicite
REVOKE EXECUTE ON FUNCTION public.auto_link_missions_to_client() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_clients_auth_user_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_clients_auth_user_id_on_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_newsletter_unsubscribe_token() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_avis_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reseau_comments_set_author_id() FROM PUBLIC;

-- =========================================================
-- 3) FIXER search_path = public SUR LES FONCTIONS SENSIBLES
-- =========================================================

ALTER FUNCTION public.admin_delete_user(uuid, text) SET search_path = public;
ALTER FUNCTION public.admin_toggle_ban(uuid, text, boolean) SET search_path = public;
ALTER FUNCTION public.is_admin() SET search_path = public;
ALTER FUNCTION public.is_admin_by_email(text) SET search_path = public;
ALTER FUNCTION public.apply_parrainage_code(text) SET search_path = public;
ALTER FUNCTION public.unsubscribe_newsletter_by_token(text) SET search_path = public;
ALTER FUNCTION public.like_reseau_post(uuid) SET search_path = public;
ALTER FUNCTION public.set_newsletter_unsubscribe_token() SET search_path = public;
ALTER FUNCTION public.auto_link_missions_to_client() SET search_path = public;
ALTER FUNCTION public.handle_new_auth_user() SET search_path = public;
ALTER FUNCTION public.set_clients_auth_user_id() SET search_path = public;
ALTER FUNCTION public.set_clients_auth_user_id_on_update() SET search_path = public;
ALTER FUNCTION public.set_avis_updated_at() SET search_path = public;
ALTER FUNCTION public.set_updated_at() SET search_path = public;
ALTER FUNCTION public.reseau_comments_set_author_id() SET search_path = public;

-- =========================================================
-- 4) INDEXES SUR LES CLÉS ÉTRANGÈRES (perf RLS)
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_avis_mission_id ON public.avis (mission_id);
CREATE INDEX IF NOT EXISTS idx_avis_user_id ON public.avis (user_id);

CREATE INDEX IF NOT EXISTS idx_candidatures_convoyeur_id ON public.candidatures (convoyeur_id);
CREATE INDEX IF NOT EXISTS idx_candidatures_mission_id ON public.candidatures (mission_id);

CREATE INDEX IF NOT EXISTS idx_convoyeur_badges_badge_id ON public.convoyeur_badges (badge_id);
CREATE INDEX IF NOT EXISTS idx_convoyeur_badges_mission_id ON public.convoyeur_badges (mission_id);

CREATE INDEX IF NOT EXISTS idx_missions_client_id ON public.missions (client_id);

CREATE INDEX IF NOT EXISTS idx_parrainages_filleul_id ON public.parrainages (filleul_id);
CREATE INDEX IF NOT EXISTS idx_parrainages_mission_id ON public.parrainages (mission_id);

CREATE INDEX IF NOT EXISTS idx_points_fidelite_mission_id ON public.points_fidelite (mission_id);

CREATE INDEX IF NOT EXISTS idx_reseau_comments_post_id ON public.reseau_comments (post_id);

CREATE INDEX IF NOT EXISTS idx_support_tickets_convoyeur_id ON public.support_tickets (convoyeur_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_mission_id ON public.support_tickets (mission_id);

NOTIFY pgrst, 'reload schema';
