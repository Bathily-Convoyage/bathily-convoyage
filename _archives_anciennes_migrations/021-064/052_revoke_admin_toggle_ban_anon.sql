-- =====================================================
-- Migration 052 : Revoke EXECUTE anon sur admin_toggle_ban
-- =====================================================

REVOKE EXECUTE ON FUNCTION public.admin_toggle_ban(uuid, text, boolean) FROM anon;

NOTIFY pgrst, 'reload schema';
