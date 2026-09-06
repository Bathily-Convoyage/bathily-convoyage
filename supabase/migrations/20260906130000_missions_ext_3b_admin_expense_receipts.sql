-- =====================================================
-- MISSIONS-EXT-3B — Admin Expense Receipts
-- =====================================================
-- Allows an authenticated ADMIN to attach a receipt / supporting
-- document to a mission expense created from the Admin panel.
--
-- Reuses the existing mission-expenses private Storage bucket and
-- the existing mission_expense_receipts table (immutable).
--
-- The existing convoyeur receipt flow (register_mission_expense_receipt)
-- requires is_operator() + draft status + submitted_by = auth.uid().
-- Admin-created expenses are status='approved' and the admin is NOT
-- an operator, so the existing RPC and storage INSERT policy cannot
-- be used. This migration adds narrowly-scoped admin-only equivalents:
--
--   1. Storage INSERT policy (admin-only, path-validated, expense exists)
--   2. Storage DELETE policy (admin-only, orphaned objects only —
--      objects NOT yet linked to any receipt row, for cleanup on
--      RPC link failure; preserves receipt immutability)
--   3. RPC admin_attach_mission_expense_receipt (admin-only, max 1
--      receipt per expense, path validation, object existence check,
--      audit event logging)
--
-- Security:
--   - SECURITY DEFINER, explicit empty search_path.
--   - Rejects anonymous callers.
--   - Allows ONLY existing admin role via is_admin().
--   - Operators, clients, and convoyeurs are ALL blocked.
--   - No broad table INSERT/UPDATE grants are added.
--   - Receipt immutability trigger remains untouched.
--   - Convoyeur storage INSERT/SELECT policies remain untouched.
--   - No public bucket exposure. No broad authenticated INSERT.
--
-- Receipt immutability:
--   - RECEIPT_REPLACE = DENY. Max 1 receipt per expense for admin.
--   - The existing mission_expense_receipts_immutable trigger blocks
--     UPDATE and DELETE on the receipts table unconditionally.
--   - The storage DELETE policy only allows deleting objects that
--     are NOT linked to any receipt row (orphan cleanup).
--
-- This migration is ADDITIVE and backward-compatible:
--   - no schema change (no new tables, no new columns)
--   - no RLS change on existing tables
--   - no grant change on tables
--   - no CHECK change
--   - two new storage policies (INSERT + DELETE, admin-only)
--   - one new function + its EXECUTE grants only
--
-- LOCAL FILE ONLY. NOT EXECUTED in this gate.
-- DO NOT apply to Production without explicit authorization.
-- =====================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- =====================================================
-- 1. STORAGE INSERT POLICY: admin receipt upload
-- =====================================================
-- Narrowly scoped: admin-only, bucket=mission-expenses, path must
-- match missions/{mission_id}/expenses/{expense_id}/..., and the
-- expense must exist with the matching mission_id.
-- Does NOT touch the existing operator INSERT policy.
-- Does NOT allow broad authenticated INSERT.

DROP POLICY IF EXISTS "mission_expenses_storage_insert_admin" ON storage.objects;
CREATE POLICY "mission_expenses_storage_insert_admin"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'mission-expenses'
    AND name ~ '^missions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/expenses/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
    AND public.is_admin()
    AND EXISTS (
      SELECT 1
      FROM public.mission_expenses me
      WHERE (me.id)::text = split_part(objects.name, '/', 4)
        AND (me.mission_id)::text = split_part(objects.name, '/', 2)
    )
  );

-- =====================================================
-- 2. STORAGE DELETE POLICY: admin orphan cleanup
-- =====================================================
-- Allows admin to delete storage objects in the mission-expenses
-- bucket ONLY when the object is NOT linked to any receipt row.
-- This enables cleanup when an upload succeeds but the RPC link
-- fails (orphan avoidance), while preserving receipt immutability:
-- once a receipt row references the storage_path, the object cannot
-- be deleted.

DROP POLICY IF EXISTS "mission_expenses_storage_delete_admin_orphan" ON storage.objects;
CREATE POLICY "mission_expenses_storage_delete_admin_orphan"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'mission-expenses'
    AND name ~ '^missions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/expenses/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
    AND public.is_admin()
    AND NOT EXISTS (
      SELECT 1
      FROM public.mission_expense_receipts mer
      WHERE mer.storage_path = objects.name
    )
  );

-- =====================================================
-- 3. RPC: admin_attach_mission_expense_receipt
-- =====================================================
-- Admin-only. Links an already-uploaded storage object to an
-- existing mission expense. Enforces:
--   - authenticated + is_admin()
--   - bucket = 'mission-expenses'
--   - MIME in allowlist (JPEG/PNG/WebP/PDF)
--   - expense exists
--   - path matches missions/{expense.mission_id}/expenses/{expense.id}/...
--   - object exists in storage with owner = auth.uid()
--   - max 1 receipt per expense (RECEIPT_REPLACE = DENY)
--   - audit event logged

CREATE OR REPLACE FUNCTION public.admin_attach_mission_expense_receipt(
  p_expense_id     uuid,
  p_storage_bucket text,
  p_storage_path   text,
  p_mime_type      text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _expense       public.mission_expenses%ROWTYPE;
  _receipt_id    uuid;
  _count         integer;
  _path_mission  text;
  _path_expense  text;
BEGIN
  -- 1. Auth required (anonymous blocked)
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- 2. Authorize: ADMIN ONLY.
  --    Operators, clients, and convoyeurs are all blocked.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- 3. Bucket must be exact
  IF p_storage_bucket <> 'mission-expenses' THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- 4. MIME type validation (server-side, do not trust client)
  IF p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') THEN
    RAISE EXCEPTION 'Type MIME non autorisé' USING ERRCODE = 'P0001';
  END IF;

  -- 5. Expense must exist
  SELECT * INTO _expense FROM public.mission_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- 6. Path must match: missions/{mission_id}/expenses/{expense_id}/...
  --    Prevents cross-mission attachment and path traversal.
  _path_mission := split_part(p_storage_path, '/', 2);
  _path_expense := split_part(p_storage_path, '/', 4);

  IF _path_mission <> (_expense.mission_id)::text OR _path_expense <> (_expense.id)::text THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- 7. Verify object exists in storage and owner is auth.uid()
  --    (admin uploaded it; no arbitrary linking of other users' objects)
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects
    WHERE bucket_id = 'mission-expenses'
      AND name = p_storage_path
      AND owner = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- 8. Max 1 receipt per expense (RECEIPT_REPLACE = DENY)
  SELECT count(*) INTO _count
  FROM public.mission_expense_receipts
  WHERE expense_id = p_expense_id;

  IF _count >= 1 THEN
    RAISE EXCEPTION 'Un justificatif maximum par frais' USING ERRCODE = 'P0001';
  END IF;

  -- 9. Insert receipt (immutable — trigger blocks future UPDATE/DELETE)
  INSERT INTO public.mission_expense_receipts (
    expense_id, storage_bucket, storage_path, mime_type, created_by
  ) VALUES (
    p_expense_id, p_storage_bucket, p_storage_path, p_mime_type, auth.uid()
  )
  RETURNING id INTO _receipt_id;

  -- 10. Audit log
  PERFORM public.log_mission_event(
    _expense.mission_id,
    'expense_receipt_attached',
    NULL,
    NULL,
    'admin',
    jsonb_build_object(
      'expense_id', _expense.id,
      'receipt_id', _receipt_id,
      'mime_type', p_mime_type,
      'admin_attached', true
    )
  );

  RETURN _receipt_id;
END;
$$;

-- =====================================================
-- 4. EXECUTE grants — match the P3.5 ACL pattern
-- =====================================================
REVOKE EXECUTE ON FUNCTION public.admin_attach_mission_expense_receipt(uuid, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_attach_mission_expense_receipt(uuid, text, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_attach_mission_expense_receipt(uuid, text, text, text) FROM authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_attach_mission_expense_receipt(uuid, text, text, text) TO authenticated, service_role;

COMMIT;
