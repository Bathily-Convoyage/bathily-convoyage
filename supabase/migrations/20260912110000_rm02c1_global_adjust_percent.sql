-- RM-02C1 — Global B2C pricing adjustment foundation.
--
-- Seeds the single persisted commercial-config value used by the RM-02
-- pricing engine: global_adjust_percent (B2C-only transport adjustment).
--
-- Idempotent: safe to re-run. No table, column, RLS policy, or grant changes.
-- Existing authenticated-admin RLS on system_settings already covers
-- SELECT / INSERT / UPDATE / DELETE for admins (see baseline migration
-- 20260807214536_remote_public_baseline.sql + p4_1b optimization).
--
-- The backend reads this row server-side via the service-role key; the
-- public browser never reads system_settings directly (no anon policy added).

INSERT INTO public.system_settings (key, value)
VALUES ('global_adjust_percent', '{"percent": 0}'::jsonb)
ON CONFLICT (key) DO NOTHING;
