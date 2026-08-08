-- =====================================================
-- Migration: phase3_b1v2_grants_cleanup
-- Objectif : nettoyer les GRANTs sur log_mission_event
-- =====================================================

BEGIN;

REVOKE EXECUTE ON FUNCTION public.log_mission_event(uuid, text, text, text, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.log_mission_event(uuid, text, text, text, text, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.log_mission_event(uuid, text, text, text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.log_mission_event(uuid, text, text, text, text, jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.log_mission_event(uuid, text, text, text, text, jsonb) TO service_role;

COMMIT;
