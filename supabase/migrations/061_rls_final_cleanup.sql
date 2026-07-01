-- =====================================================
-- Migration 061 : Nettoyage final sécurité RLS / RPC
--    - Index FK manquant sur campagnes(created_by)
--    - Révocations explicites anon/authenticated sur fonctions triggers
--    - Révocations explicites anon sur fonctions métier authenticated-only
-- =====================================================

-- 1) Index FK manquant signalé par l'audit
CREATE INDEX IF NOT EXISTS idx_campagnes_created_by
  ON public.campagnes (created_by);

-- 2) Fonctions métier réservées aux authenticated : révocation explicite d'anon
REVOKE EXECUTE ON FUNCTION public.apply_parrainage_code(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.like_reseau_post(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_toggle_ban(uuid, text, boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_admin_by_email(text) FROM anon;

-- 3) Fonctions triggers / internes : révocation explicite d'anon et authenticated
REVOKE EXECUTE ON FUNCTION public.auto_link_missions_to_client() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_clients_auth_user_id() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_clients_auth_user_id_on_update() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_newsletter_unsubscribe_token() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_avis_updated_at() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reseau_comments_set_author_id() FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
