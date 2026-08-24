BEGIN;

-- New functions must be private by default. Every API-facing function must
-- receive an explicit grant in the migration that creates it.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

-- Trigger functions are invoked by PostgreSQL, never through PostgREST.
REVOKE EXECUTE ON FUNCTION public.enqueue_mission_notification() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.guard_clients_privileged_fields() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.sync_user_roles_on_client_role() FROM PUBLIC, anon, authenticated, service_role;

-- These RPCs are authenticated workflows. Their internal authorization gates
-- remain unchanged; anonymous callers no longer reach them at all.
REVOKE EXECUTE ON FUNCTION public.admin_assign_mission(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.authorize_gps_session(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.record_gps_position(uuid, double precision, double precision, double precision, double precision) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.respond_mission_assignment(uuid, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_tracking_token(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.transition_mission_status(uuid, text, text, jsonb) FROM PUBLIC, anon;

-- Keep the existing authenticated dashboard contract explicit.
GRANT EXECUTE ON FUNCTION public.admin_assign_mission(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_gps_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_gps_position(uuid, double precision, double precision, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_mission_assignment(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_tracking_token(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_mission_status(uuid, text, text, jsonb) TO authenticated;

-- This legacy email-enumeration helper has no application call site. Retain it
-- for operational compatibility, but restrict it to the backend role.
CREATE OR REPLACE FUNCTION public.is_admin_by_email(user_email text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.clients
    WHERE email = user_email
      AND role = 'admin'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin_by_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin_by_email(text) TO service_role;

-- Existing functions already qualify their object references, so an empty
-- search_path removes the remaining object-shadowing surface.
ALTER FUNCTION public.admin_toggle_ban(uuid, text, boolean) SET search_path TO '';
ALTER FUNCTION public.unsubscribe_newsletter_by_token(text) SET search_path TO '';

-- One durable row per user/post makes likes idempotent and prevents repeated
-- counter inflation by the same authenticated account.
CREATE TABLE public.reseau_post_likes (
  post_id uuid NOT NULL REFERENCES public.reseau_posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

ALTER TABLE public.reseau_post_likes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.reseau_post_likes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.reseau_post_likes TO service_role;

CREATE OR REPLACE FUNCTION public.like_reseau_post(post_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_inserted integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Non autorise' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.clients c
    WHERE c.auth_user_id = v_user_id AND c.role = 'admin'
  ) AND NOT EXISTS (
    SELECT 1 FROM public.convoyeurs v
    WHERE v.auth_user_id = v_user_id AND v.banned = false
  ) THEN
    RAISE EXCEPTION 'Non autorise' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.reseau_post_likes (post_id, user_id)
  VALUES (post_id, v_user_id)
  ON CONFLICT (post_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    UPDATE public.reseau_posts
    SET likes_count = COALESCE(likes_count, 0) + 1
    WHERE id = post_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Publication introuvable' USING ERRCODE = 'P0002';
    END IF;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.like_reseau_post(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.like_reseau_post(uuid) TO authenticated;

COMMIT;
