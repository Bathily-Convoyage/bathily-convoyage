BEGIN;

-- P3.5 freezes the intended PostgREST RPC surface after the Supabase
-- SECURITY DEFINER advisor introduced role-specific executable warnings.
-- Every function below first loses all client/backend grants, then receives
-- only the documented allowlist. The owner (postgres) keeps implicit access.

-- Anonymous capability endpoints. Their inputs are either non-sensitive or
-- high-entropy capability tokens, so both public and signed-in callers need
-- access. PUBLIC is deliberately excluded to avoid granting future roles.
REVOKE EXECUTE ON FUNCTION public.external_convoyeurs_enabled() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_public_tracking(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.unsubscribe_newsletter_by_token(text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.external_convoyeurs_enabled() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_tracking(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unsubscribe_newsletter_by_token(text) TO anon, authenticated, service_role;

-- Authenticated authorization helpers. Anonymous callers have no legitimate
-- use for these functions; removing anon also clears two advisor warnings.
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_internal_user() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_operator() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_internal_user() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_operator() TO authenticated, service_role;

-- Authenticated workflows also used by trusted backend operations.
REVOKE EXECUTE ON FUNCTION public.admin_assign_mission(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_toggle_ban(uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.apply_parrainage_code(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.authorize_gps_session(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.create_mission_expense_draft(uuid, text, numeric, date, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.create_tracking_token(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.delete_mission_expense_draft(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_mission_contact(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.mark_mission_paid(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.record_gps_position(uuid, double precision, double precision, double precision, double precision) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.register_mission_expense_receipt(uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.register_mission_incident_evidence(uuid, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.report_mission_incident(uuid, text, text, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.respond_mission_assignment(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.review_mission_expense(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.review_mission_incident(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.revoke_tracking_token(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.submit_mission_expense(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.transition_mission_status(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.update_mission_expense_draft(uuid, text, numeric, date, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.update_mission_incident(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_assign_mission(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_toggle_ban(uuid, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_parrainage_code(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.authorize_gps_session(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_mission_expense_draft(uuid, text, numeric, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_tracking_token(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_mission_expense_draft(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_mission_contact(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_mission_paid(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_gps_position(uuid, double precision, double precision, double precision, double precision) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_mission_expense_receipt(uuid, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_mission_incident_evidence(uuid, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.report_mission_incident(uuid, text, text, text, text, timestamptz, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.respond_mission_assignment(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_mission_expense(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_mission_incident(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_tracking_token(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_mission_expense(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transition_mission_status(uuid, text, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_mission_expense_draft(uuid, text, numeric, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_mission_incident(uuid, text, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid, text) TO authenticated, service_role;

-- These dashboard-only mutations are intentionally unavailable to the
-- service role because no backend call site uses them.
REVOKE EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.like_reseau_post(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.like_reseau_post(uuid) TO authenticated;

-- All other SECURITY DEFINER functions already use an empty search_path.
-- Bring the sole remaining exception in line with that invariant.
ALTER FUNCTION public.apply_parrainage_code(text) SET search_path TO '';

COMMIT;
