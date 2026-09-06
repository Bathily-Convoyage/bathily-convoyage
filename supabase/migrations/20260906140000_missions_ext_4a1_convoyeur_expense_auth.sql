-- =============================================================
-- MISSIONS-EXT-4A1 — Convoyeur field execution unblock
-- Forward-only migration. Does not edit any historical migration.
--
-- Problem:
--   create_mission_expense_draft, update_mission_expense_draft,
--   delete_mission_expense_draft, submit_mission_expense, and
--   register_mission_expense_receipt all require
--   is_operator() AND is_convoyeur_for_mission().
--   A pure assigned convoyeur (not operator) is denied at the
--   first predicate. The expense/receipt workflow is therefore
--   unreachable for non-operator convoyeurs.
--
-- Fix:
--   Replace the is_operator() AND is_convoyeur_for_mission()
--   authorization pattern with an explicit non-banned assignment
--   check that does NOT require is_operator(). The convoyeur must
--   still be:
--     - authenticated (auth.uid() IS NOT NULL)
--     - auth-linked to a convoyeur profile assigned to the mission
--     - not banned (c.banned = false)
--   Owner checks (submitted_by = auth.uid()) and lifecycle gates
--   (status = 'draft', mission status, receipt count, path
--   validation) are preserved exactly.
--
-- RLS and Storage policies are also relaxed so a pure assigned
--   convoyeur can SELECT their own expenses/receipts and INSERT
--   receipt files, without granting broad DML.
--
-- Admin review workflow (review_mission_expense) is unchanged.
-- Admin expense creation (admin_create_mission_expense) is
--   unchanged.
-- MISSIONS-EXT-3B admin receipt flow is unchanged.
-- Immutability triggers are unchanged.
-- =============================================================

-- =============================================================
-- 1. Helper: is_assigned_non_banned_convoyeur
-- =============================================================
-- Narrowly scoped helper used by the redefined RPCs. Checks that
-- the caller is auth-linked to a convoyeur profile that is assigned
-- to the given mission and not banned. Does NOT require is_operator().
CREATE OR REPLACE FUNCTION public.is_assigned_non_banned_convoyeur(
  p_mission_id uuid,
  p_user_id    uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.missions m
    JOIN public.convoyeurs c ON c.id = m.convoyeur_id
    WHERE m.id = p_mission_id
      AND c.auth_user_id = p_user_id
      AND c.banned = false
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_assigned_non_banned_convoyeur(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_assigned_non_banned_convoyeur(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_assigned_non_banned_convoyeur(uuid, uuid) TO authenticated;

-- =============================================================
-- 2. RPC: create_mission_expense_draft (redefined)
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_mission_expense_draft(
  p_mission_id   uuid,
  p_expense_type text,
  p_amount       numeric,
  p_expense_date date,
  p_description  text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _mission     public.missions%ROWTYPE;
  _expense_id  uuid;
  _desc_trim   text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- MISSIONS-EXT-4A1: assigned non-banned convoyeur (not operator-only).
  IF NOT public.is_assigned_non_banned_convoyeur(p_mission_id, auth.uid()) THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _mission FROM public.missions WHERE id = p_mission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF _mission.status NOT IN ('accepted', 'in_progress', 'delivered', 'completed') THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF p_expense_type NOT IN ('fuel', 'charging', 'toll', 'parking', 'return_transport', 'washing', 'other') THEN
    RAISE EXCEPTION 'Type de frais invalide' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant invalide' USING ERRCODE = 'P0001';
  END IF;

  _desc_trim := btrim(p_description);
  IF _desc_trim IS NULL OR length(_desc_trim) = 0 OR length(p_description) > 500 THEN
    RAISE EXCEPTION 'Description invalide' USING ERRCODE = 'P0001';
  END IF;

  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'Date de frais invalide' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.mission_expenses (
    mission_id, submitted_by, expense_type, amount, currency,
    expense_date, description, status
  ) VALUES (
    p_mission_id, auth.uid(), p_expense_type, p_amount, 'EUR',
    p_expense_date, p_description, 'draft'
  )
  RETURNING id INTO _expense_id;

  RETURN _expense_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_mission_expense_draft(uuid, text, numeric, date, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_mission_expense_draft(uuid, text, numeric, date, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_mission_expense_draft(uuid, text, numeric, date, text) TO authenticated;

-- =============================================================
-- 3. RPC: update_mission_expense_draft (redefined)
-- =============================================================
CREATE OR REPLACE FUNCTION public.update_mission_expense_draft(
  p_expense_id   uuid,
  p_expense_type text,
  p_amount       numeric,
  p_expense_date date,
  p_description  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _expense     public.mission_expenses%ROWTYPE;
  _desc_trim   text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _expense FROM public.mission_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- MISSIONS-EXT-4A1: assigned non-banned convoyeur + owner.
  IF NOT public.is_assigned_non_banned_convoyeur(_expense.mission_id, auth.uid())
     OR _expense.submitted_by <> auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF _expense.status <> 'draft' THEN
    RAISE EXCEPTION 'Frais non modifiable' USING ERRCODE = 'P0001';
  END IF;

  IF p_expense_type NOT IN ('fuel', 'charging', 'toll', 'parking', 'return_transport', 'washing', 'other') THEN
    RAISE EXCEPTION 'Type de frais invalide' USING ERRCODE = 'P0001';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant invalide' USING ERRCODE = 'P0001';
  END IF;

  _desc_trim := btrim(p_description);
  IF _desc_trim IS NULL OR length(_desc_trim) = 0 OR length(p_description) > 500 THEN
    RAISE EXCEPTION 'Description invalide' USING ERRCODE = 'P0001';
  END IF;

  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'Date de frais invalide' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.mission_expenses
  SET expense_type = p_expense_type,
      amount       = p_amount,
      expense_date = p_expense_date,
      description  = p_description
  WHERE id = p_expense_id AND status = 'draft';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_mission_expense_draft(uuid, text, numeric, date, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_mission_expense_draft(uuid, text, numeric, date, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_mission_expense_draft(uuid, text, numeric, date, text) TO authenticated;

-- =============================================================
-- 4. RPC: register_mission_expense_receipt (redefined)
-- =============================================================
CREATE OR REPLACE FUNCTION public.register_mission_expense_receipt(
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
  _expense     public.mission_expenses%ROWTYPE;
  _receipt_id  uuid;
  _count       integer;
  _path_mission text;
  _path_expense text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF p_storage_bucket <> 'mission-expenses' THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') THEN
    RAISE EXCEPTION 'Type MIME non autorisé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO _expense FROM public.mission_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- MISSIONS-EXT-4A1: assigned non-banned convoyeur + owner.
  IF NOT public.is_assigned_non_banned_convoyeur(_expense.mission_id, auth.uid())
     OR _expense.submitted_by <> auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF _expense.status <> 'draft' THEN
    RAISE EXCEPTION 'Justificatif non ajoutable' USING ERRCODE = 'P0001';
  END IF;

  _path_mission := split_part(p_storage_path, '/', 2);
  _path_expense := split_part(p_storage_path, '/', 4);

  IF _path_mission <> (_expense.mission_id)::text OR _path_expense <> (_expense.id)::text THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM storage.objects
    WHERE bucket_id = 'mission-expenses'
      AND name = p_storage_path
      AND owner = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO _count
  FROM public.mission_expense_receipts
  WHERE expense_id = p_expense_id;

  IF _count >= 3 THEN
    RAISE EXCEPTION 'Maximum 3 justificatifs par frais' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.mission_expense_receipts (
    expense_id, storage_bucket, storage_path, mime_type, created_by
  ) VALUES (
    p_expense_id, p_storage_bucket, p_storage_path, p_mime_type, auth.uid()
  )
  RETURNING id INTO _receipt_id;

  RETURN _receipt_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_mission_expense_receipt(uuid, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.register_mission_expense_receipt(uuid, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_mission_expense_receipt(uuid, text, text, text) TO authenticated;

-- =============================================================
-- 5. RPC: submit_mission_expense (redefined)
-- =============================================================
CREATE OR REPLACE FUNCTION public.submit_mission_expense(
  p_expense_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _expense     public.mission_expenses%ROWTYPE;
  _mission     public.missions%ROWTYPE;
  _receipt_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _expense FROM public.mission_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- MISSIONS-EXT-4A1: assigned non-banned convoyeur + owner.
  IF NOT public.is_assigned_non_banned_convoyeur(_expense.mission_id, auth.uid())
     OR _expense.submitted_by <> auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF _expense.status <> 'draft' THEN
    RAISE EXCEPTION 'Frais non soumissible' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO _mission FROM public.missions WHERE id = _expense.mission_id;
  IF NOT FOUND OR _mission.status NOT IN ('accepted', 'in_progress', 'delivered', 'completed') THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO _receipt_count
  FROM public.mission_expense_receipts
  WHERE expense_id = p_expense_id;

  IF _expense.expense_type <> 'washing' AND _receipt_count < 1 THEN
    RAISE EXCEPTION 'Justificatif obligatoire manquant' USING ERRCODE = 'P0001';
  END IF;

  IF _receipt_count > 3 THEN
    RAISE EXCEPTION 'Maximum 3 justificatifs par frais' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.mission_expenses
  SET status = 'submitted',
      submitted_at = now()
  WHERE id = p_expense_id AND status = 'draft';

  PERFORM public.log_mission_event(
    _expense.mission_id,
    'expense_submitted',
    NULL,
    NULL,
    'convoyeur',
    jsonb_build_object(
      'expense_id', p_expense_id,
      'expense_type', _expense.expense_type
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_mission_expense(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_mission_expense(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_mission_expense(uuid) TO authenticated;

-- =============================================================
-- 6. RPC: delete_mission_expense_draft (redefined)
-- =============================================================
CREATE OR REPLACE FUNCTION public.delete_mission_expense_draft(
  p_expense_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _expense     public.mission_expenses%ROWTYPE;
  _receipt_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _expense FROM public.mission_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- MISSIONS-EXT-4A1: assigned non-banned convoyeur + owner.
  IF NOT public.is_assigned_non_banned_convoyeur(_expense.mission_id, auth.uid())
     OR _expense.submitted_by <> auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF _expense.status <> 'draft' THEN
    RAISE EXCEPTION 'Suppression non autorisée' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO _receipt_count
  FROM public.mission_expense_receipts
  WHERE expense_id = p_expense_id;

  IF _receipt_count > 0 THEN
    RAISE EXCEPTION 'Suppression impossible : justificatif(s) enregistré(s)' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.mission_expenses WHERE id = p_expense_id AND status = 'draft';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_mission_expense_draft(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_mission_expense_draft(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_mission_expense_draft(uuid) TO authenticated;

-- =============================================================
-- 7. RLS: mission_expenses — relax SELECT for assigned convoyeur
-- =============================================================
-- The admin policy is unchanged. The operator-assigned policy is
-- replaced so a pure assigned non-banned convoyeur can SELECT their
-- own expenses (submitted_by = auth.uid()) without is_operator().
DROP POLICY IF EXISTS "mission_expenses_select_operator_assigned" ON public.mission_expenses;
CREATE POLICY "mission_expenses_select_convoyeur_assigned"
  ON public.mission_expenses
  FOR SELECT
  TO authenticated
  USING (
    submitted_by = auth.uid()
    AND public.is_assigned_non_banned_convoyeur(mission_expenses.mission_id, auth.uid())
  );

-- =============================================================
-- 8. RLS: mission_expense_receipts — relax SELECT for assigned convoyeur
-- =============================================================
DROP POLICY IF EXISTS "mission_expense_receipts_select_operator_assigned" ON public.mission_expense_receipts;
CREATE POLICY "mission_expense_receipts_select_convoyeur_assigned"
  ON public.mission_expense_receipts
  FOR SELECT
  TO authenticated
  USING (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.mission_expenses me
      WHERE me.id = mission_expense_receipts.expense_id
        AND me.submitted_by = auth.uid()
        AND public.is_assigned_non_banned_convoyeur(me.mission_id, auth.uid())
    )
  );

-- =============================================================
-- 9. STORAGE RLS: mission-expenses bucket — relax for convoyeur
-- =============================================================
-- INSERT: assigned non-banned convoyeur + expense draft + path matches.
-- Replaces the operator-only INSERT policy.
DROP POLICY IF EXISTS "mission_expenses_storage_insert" ON storage.objects;
CREATE POLICY "mission_expenses_storage_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'mission-expenses'
    AND name ~ '^missions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/expenses/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
    AND EXISTS (
      SELECT 1
      FROM public.missions m
      JOIN public.convoyeurs cv ON cv.id = m.convoyeur_id
      WHERE (m.id)::text = split_part(objects.name, '/', 2)
        AND cv.auth_user_id = auth.uid()
        AND cv.banned = false
    )
    AND EXISTS (
      SELECT 1
      FROM public.mission_expenses me
      WHERE (me.id)::text = split_part(objects.name, '/', 4)
        AND (me.mission_id)::text = split_part(objects.name, '/', 2)
        AND me.submitted_by = auth.uid()
        AND me.status = 'draft'
    )
  );

-- SELECT: admin all, OR assigned non-banned convoyeur who owns the expense.
-- Replaces the operator-only SELECT policy.
DROP POLICY IF EXISTS "mission_expenses_storage_select" ON storage.objects;
CREATE POLICY "mission_expenses_storage_select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'mission-expenses'
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.mission_expenses me
        JOIN public.missions m ON m.id = me.mission_id
        JOIN public.convoyeurs cv ON cv.id = m.convoyeur_id
        WHERE (me.id)::text = split_part(objects.name, '/', 4)
          AND (me.mission_id)::text = split_part(objects.name, '/', 2)
          AND me.submitted_by = auth.uid()
          AND cv.auth_user_id = auth.uid()
          AND cv.banned = false
      )
    )
  );

-- No UPDATE or DELETE policies on storage.objects for this bucket.
-- MISSIONS-EXT-3B admin orphan-delete policy remains unchanged.
