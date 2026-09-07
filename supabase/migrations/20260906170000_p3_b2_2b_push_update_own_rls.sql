-- =====================================================
-- P3-B2.2B — Push Subscriptions UPDATE RLS
-- =====================================================
-- Business rule:
--   An authenticated user may UPDATE their own push_subscriptions
--   rows to refresh p256dh, auth_key, and user_agent when the
--   browser re-subscribes with the same endpoint but new keys.
--
-- This migration is ADDITIVE and forward-only:
--   - Adds a single UPDATE RLS policy: push_update_own
--   - Uses (select auth.uid()) initplan optimization convention
--     (consistent with 20260825151634_optimize_rls_auth_initplan_p4_1b.sql)
--   - Both USING and WITH CHECK enforce user_id = (select auth.uid())
--   - Does NOT modify SELECT, INSERT, or DELETE policies
--   - Does NOT alter table schema, constraints, indexes, or grants
--   - Does NOT affect service_role bypass
--   - Idempotent: DROP POLICY IF EXISTS before CREATE
--
-- Security:
--   USING prevents updating another user's rows
--   WITH CHECK prevents reassigning user_id to another user
--   Only the authenticated role is granted UPDATE via RLS
-- =====================================================

-- Drop existing policy if present (idempotent)
DROP POLICY IF EXISTS "push_update_own" ON "public"."push_subscriptions";

-- Create UPDATE policy for authenticated users on their own rows
CREATE POLICY "push_update_own"
  ON "public"."push_subscriptions"
  FOR UPDATE
  TO "authenticated"
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));
