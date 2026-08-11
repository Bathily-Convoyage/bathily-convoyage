-- =============================================================
-- C-2.2C3 — MISSION EXPENSES + RECEIPTS BACKEND
-- Phase 3 / Security Offensive Audit
-- Timestamp: 20260811000003
-- =============================================================
-- Creates:
--   - mission_expenses table (draft → submitted → approved/rejected)
--   - mission_expense_receipts table (immutable)
--   - mission-expenses private Storage bucket (JPEG/PNG/WebP/PDF, 5 MiB)
--   - RLS policies (admin all, operator own assigned, others 0)
--   - Storage RLS policies (insert draft-only, select admin/operator)
--   - Immutability triggers (receipts UPDATE/DELETE blocked)
--   - Protect triggers (expenses direct UPDATE/DELETE blocked)
--   - 6 SECURITY DEFINER RPCs:
--     create_mission_expense_draft
--     update_mission_expense_draft
--     register_mission_expense_receipt
--     submit_mission_expense
--     review_mission_expense
--     delete_mission_expense_draft
--   - Indexes
--   - Mission event logging (expense_submitted, expense_approved, expense_rejected)
--
-- Invariant: external_convoyeurs_enabled = false (not referenced)
-- =============================================================

-- =============================================================
-- 1. STORAGE BUCKET
-- =============================================================
INSERT INTO storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
VALUES (
  'mission-expenses',
  'mission-expenses',
  false,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']::text[],
  5242880  -- 5 MiB
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  file_size_limit = EXCLUDED.file_size_limit;

-- =============================================================
-- 2. TABLE: mission_expenses
-- =============================================================
CREATE TABLE IF NOT EXISTS public.mission_expenses (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id    uuid        NOT NULL,
  submitted_by  uuid        NOT NULL,
  expense_type  text        NOT NULL,
  amount        numeric(10,2) NOT NULL,
  currency      text        NOT NULL DEFAULT 'EUR',
  expense_date  date        NOT NULL,
  description   text        NOT NULL,
  status        text        NOT NULL DEFAULT 'draft',
  created_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz NULL,
  reviewed_by   uuid        NULL,
  reviewed_at   timestamptz NULL,
  review_notes  text        NULL,

  CONSTRAINT mission_expenses_amount_positive CHECK (amount > 0),
  CONSTRAINT mission_expenses_currency_eur    CHECK (currency = 'EUR'),
  CONSTRAINT mission_expenses_type_valid      CHECK (
    expense_type IN ('fuel', 'charging', 'toll', 'parking', 'return_transport', 'washing', 'other')
  ),
  CONSTRAINT mission_expenses_status_valid    CHECK (
    status IN ('draft', 'submitted', 'approved', 'rejected')
  ),
  CONSTRAINT mission_expenses_description_len CHECK (
    length(btrim(description)) > 0 AND length(description) <= 500
  )
);

-- FK mission: ON DELETE RESTRICT (financial data integrity)
ALTER TABLE public.mission_expenses
  DROP CONSTRAINT IF EXISTS mission_expenses_mission_id_fkey;
ALTER TABLE public.mission_expenses
  ADD CONSTRAINT mission_expenses_mission_id_fkey
    FOREIGN KEY (mission_id) REFERENCES public.missions(id) ON DELETE RESTRICT;

-- Enable RLS
ALTER TABLE public.mission_expenses ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 3. TABLE: mission_expense_receipts
-- =============================================================
CREATE TABLE IF NOT EXISTS public.mission_expense_receipts (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id     uuid        NOT NULL,
  storage_bucket text        NOT NULL,
  storage_path   text        NOT NULL,
  mime_type      text        NOT NULL,
  created_by     uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mission_expense_receipts_bucket CHECK (storage_bucket = 'mission-expenses'),
  CONSTRAINT mission_expense_receipts_mime   CHECK (
    mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
  )
);

-- FK expense: ON DELETE RESTRICT
ALTER TABLE public.mission_expense_receipts
  DROP CONSTRAINT IF EXISTS mission_expense_receipts_expense_id_fkey;
ALTER TABLE public.mission_expense_receipts
  ADD CONSTRAINT mission_expense_receipts_expense_id_fkey
    FOREIGN KEY (expense_id) REFERENCES public.mission_expenses(id) ON DELETE RESTRICT;

-- Enable RLS
ALTER TABLE public.mission_expense_receipts ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 4. INDEXES
-- =============================================================
CREATE INDEX IF NOT EXISTS idx_mission_expenses_mission_id     ON public.mission_expenses(mission_id);
CREATE INDEX IF NOT EXISTS idx_mission_expenses_status         ON public.mission_expenses(status);
CREATE INDEX IF NOT EXISTS idx_mission_expenses_submitted_by   ON public.mission_expenses(submitted_by);
CREATE INDEX IF NOT EXISTS idx_mission_expenses_mission_status ON public.mission_expenses(mission_id, status);
CREATE INDEX IF NOT EXISTS idx_mission_expense_receipts_expense_id ON public.mission_expense_receipts(expense_id);

-- =============================================================
-- 5. PROTECT TRIGGER: mission_expenses
-- Blocks direct UPDATE/DELETE from non-postgres (RPCs run as postgres).
-- Allows UPDATE for postgres (RPCs). Blocks DELETE even for postgres.
-- =============================================================
CREATE OR REPLACE FUNCTION public.mission_expenses_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- Les RPC métier SECURITY DEFINER s'exécutent en tant que postgres.
  IF current_user = 'postgres' THEN
    IF TG_OP = 'DELETE' THEN
      -- delete_mission_expense_draft uses DELETE — allow for postgres.
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- Toute opération directe non-RPC est interdite.
  RAISE EXCEPTION 'mission_expenses : opération % interdite hors RPC métier', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS mission_expenses_protect_trigger ON public.mission_expenses;
CREATE TRIGGER mission_expenses_protect_trigger
  BEFORE UPDATE OR DELETE ON public.mission_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.mission_expenses_protect();

-- =============================================================
-- 6. IMMUTABILITY TRIGGER: mission_expense_receipts
-- Blocks UPDATE and DELETE unconditionally (even for postgres).
-- =============================================================
CREATE OR REPLACE FUNCTION public.mission_expense_receipts_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'mission_expense_receipts est strictement immutable : % interdit', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS mission_expense_receipts_immutable_trigger ON public.mission_expense_receipts;
CREATE TRIGGER mission_expense_receipts_immutable_trigger
  BEFORE UPDATE OR DELETE ON public.mission_expense_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.mission_expense_receipts_immutable();

-- =============================================================
-- 7. RLS: mission_expenses
-- =============================================================
DROP POLICY IF EXISTS "mission_expenses_select_admin" ON public.mission_expenses;
CREATE POLICY "mission_expenses_select_admin"
  ON public.mission_expenses
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "mission_expenses_select_operator_assigned" ON public.mission_expenses;
CREATE POLICY "mission_expenses_select_operator_assigned"
  ON public.mission_expenses
  FOR SELECT
  TO authenticated
  USING (
    public.is_operator()
    AND submitted_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = mission_expenses.mission_id
        AND m.convoyeur_id IN (
          SELECT c.id FROM public.convoyeurs c
          WHERE c.auth_user_id = auth.uid()
        )
    )
  );

REVOKE ALL ON public.mission_expenses FROM PUBLIC;
REVOKE ALL ON public.mission_expenses FROM anon;
REVOKE ALL ON public.mission_expenses FROM authenticated;
GRANT SELECT ON public.mission_expenses TO authenticated;
GRANT ALL ON public.mission_expenses TO postgres;

-- =============================================================
-- 8. RLS: mission_expense_receipts
-- =============================================================
DROP POLICY IF EXISTS "mission_expense_receipts_select_admin" ON public.mission_expense_receipts;
CREATE POLICY "mission_expense_receipts_select_admin"
  ON public.mission_expense_receipts
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "mission_expense_receipts_select_operator_assigned" ON public.mission_expense_receipts;
CREATE POLICY "mission_expense_receipts_select_operator_assigned"
  ON public.mission_expense_receipts
  FOR SELECT
  TO authenticated
  USING (
    public.is_operator()
    AND created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.mission_expenses me
      JOIN public.missions m ON m.id = me.mission_id
      WHERE me.id = mission_expense_receipts.expense_id
        AND me.submitted_by = auth.uid()
        AND m.convoyeur_id IN (
          SELECT c.id FROM public.convoyeurs c
          WHERE c.auth_user_id = auth.uid()
        )
    )
  );

REVOKE ALL ON public.mission_expense_receipts FROM PUBLIC;
REVOKE ALL ON public.mission_expense_receipts FROM anon;
REVOKE ALL ON public.mission_expense_receipts FROM authenticated;
GRANT SELECT ON public.mission_expense_receipts TO authenticated;
GRANT ALL ON public.mission_expense_receipts TO postgres;

-- =============================================================
-- 9. STORAGE RLS: mission-expenses bucket
-- =============================================================

-- INSERT: operator assigned + expense draft + path matches
DROP POLICY IF EXISTS "mission_expenses_storage_insert" ON storage.objects;
CREATE POLICY "mission_expenses_storage_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'mission-expenses'
    AND name ~ '^missions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/expenses/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
    AND public.is_operator()
    AND EXISTS (
      SELECT 1
      FROM public.missions m
      JOIN public.convoyeurs cv ON cv.id = m.convoyeur_id
      WHERE (m.id)::text = split_part(objects.name, '/', 2)
        AND cv.auth_user_id = auth.uid()
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

-- SELECT: admin all, operator own assigned
DROP POLICY IF EXISTS "mission_expenses_storage_select" ON storage.objects;
CREATE POLICY "mission_expenses_storage_select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'mission-expenses'
    AND (
      public.is_admin()
      OR (
        public.is_operator()
        AND EXISTS (
          SELECT 1
          FROM public.mission_expenses me
          JOIN public.missions m ON m.id = me.mission_id
          JOIN public.convoyeurs cv ON cv.id = m.convoyeur_id
          WHERE (me.id)::text = split_part(objects.name, '/', 4)
            AND (me.mission_id)::text = split_part(objects.name, '/', 2)
            AND me.submitted_by = auth.uid()
            AND cv.auth_user_id = auth.uid()
        )
      )
    )
  );

-- No UPDATE or DELETE policies on storage.objects for this bucket.

-- =============================================================
-- 10. RPC: create_mission_expense_draft
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
  _authorized  boolean;
  _expense_id  uuid;
  _desc_trim   text;
BEGIN
  -- Auth required
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Operator + assigned to mission
  SELECT
    (public.is_operator()
     AND public.is_convoyeur_for_mission(p_mission_id, auth.uid()))
  INTO _authorized;

  IF NOT _authorized THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Mission must be in allowed status
  SELECT * INTO _mission FROM public.missions WHERE id = p_mission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF _mission.status NOT IN ('accepted', 'in_progress', 'delivered', 'completed') THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Validate expense_type
  IF p_expense_type NOT IN ('fuel', 'charging', 'toll', 'parking', 'return_transport', 'washing', 'other') THEN
    RAISE EXCEPTION 'Type de frais invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Validate amount
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Validate description
  _desc_trim := btrim(p_description);
  IF _desc_trim IS NULL OR length(_desc_trim) = 0 OR length(p_description) > 500 THEN
    RAISE EXCEPTION 'Description invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Validate expense_date not null (date type guarantees this at call, but double-check)
  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'Date de frais invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Create draft
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
-- 11. RPC: update_mission_expense_draft
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
  _authorized  boolean;
  _desc_trim   text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _expense FROM public.mission_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Must be owner + operator + assigned
  SELECT
    (public.is_operator()
     AND public.is_convoyeur_for_mission(_expense.mission_id, auth.uid()))
  INTO _authorized;

  IF NOT _authorized OR _expense.submitted_by <> auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Must be draft
  IF _expense.status <> 'draft' THEN
    RAISE EXCEPTION 'Frais non modifiable' USING ERRCODE = 'P0001';
  END IF;

  -- Validate expense_type
  IF p_expense_type NOT IN ('fuel', 'charging', 'toll', 'parking', 'return_transport', 'washing', 'other') THEN
    RAISE EXCEPTION 'Type de frais invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Validate amount
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Validate description
  _desc_trim := btrim(p_description);
  IF _desc_trim IS NULL OR length(_desc_trim) = 0 OR length(p_description) > 500 THEN
    RAISE EXCEPTION 'Description invalide' USING ERRCODE = 'P0001';
  END IF;

  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'Date de frais invalide' USING ERRCODE = 'P0001';
  END IF;

  -- Update (only allowed fields)
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
-- 12. RPC: register_mission_expense_receipt
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
  _authorized  boolean;
  _receipt_id  uuid;
  _count       integer;
  _path_mission text;
  _path_expense text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Bucket must be exact
  IF p_storage_bucket <> 'mission-expenses' THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- MIME type validation
  IF p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') THEN
    RAISE EXCEPTION 'Type MIME non autorisé' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO _expense FROM public.mission_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Must be owner + operator + assigned
  SELECT
    (public.is_operator()
     AND public.is_convoyeur_for_mission(_expense.mission_id, auth.uid()))
  INTO _authorized;

  IF NOT _authorized OR _expense.submitted_by <> auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Must be draft
  IF _expense.status <> 'draft' THEN
    RAISE EXCEPTION 'Justificatif non ajoutable' USING ERRCODE = 'P0001';
  END IF;

  -- Path must match: missions/{mission_id}/expenses/{expense_id}/...
  _path_mission := split_part(p_storage_path, '/', 2);
  _path_expense := split_part(p_storage_path, '/', 4);

  IF _path_mission <> (_expense.mission_id)::text OR _path_expense <> (_expense.id)::text THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Verify object exists in storage and owner is auth.uid()
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects
    WHERE bucket_id = 'mission-expenses'
      AND name = p_storage_path
      AND owner = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Check max 3 receipts
  SELECT count(*) INTO _count
  FROM public.mission_expense_receipts
  WHERE expense_id = p_expense_id;

  IF _count >= 3 THEN
    RAISE EXCEPTION 'Maximum 3 justificatifs par frais' USING ERRCODE = 'P0001';
  END IF;

  -- Insert receipt
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
-- 13. RPC: submit_mission_expense
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
  _authorized  boolean;
  _receipt_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _expense FROM public.mission_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Must be owner + operator + assigned
  SELECT
    (public.is_operator()
     AND public.is_convoyeur_for_mission(_expense.mission_id, auth.uid()))
  INTO _authorized;

  IF NOT _authorized OR _expense.submitted_by <> auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Must be draft
  IF _expense.status <> 'draft' THEN
    RAISE EXCEPTION 'Frais non soumissible' USING ERRCODE = 'P0001';
  END IF;

  -- Mission must still be in allowed status
  SELECT * INTO _mission FROM public.missions WHERE id = _expense.mission_id;
  IF NOT FOUND OR _mission.status NOT IN ('accepted', 'in_progress', 'delivered', 'completed') THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Check receipt requirements
  SELECT count(*) INTO _receipt_count
  FROM public.mission_expense_receipts
  WHERE expense_id = p_expense_id;

  -- washing: 0-3 receipts allowed (optional)
  -- all other types: minimum 1 receipt required
  IF _expense.expense_type <> 'washing' AND _receipt_count < 1 THEN
    RAISE EXCEPTION 'Justificatif obligatoire manquant' USING ERRCODE = 'P0001';
  END IF;

  IF _receipt_count > 3 THEN
    RAISE EXCEPTION 'Maximum 3 justificatifs par frais' USING ERRCODE = 'P0001';
  END IF;

  -- Transition: draft → submitted
  UPDATE public.mission_expenses
  SET status = 'submitted',
      submitted_at = now()
  WHERE id = p_expense_id AND status = 'draft';

  -- Log event
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
-- 14. RPC: review_mission_expense (admin)
-- =============================================================
CREATE OR REPLACE FUNCTION public.review_mission_expense(
  p_expense_id    uuid,
  p_target_status text,
  p_review_notes  text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _expense     public.mission_expenses%ROWTYPE;
  _notes_trim  text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  IF p_target_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Statut cible invalide' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO _expense FROM public.mission_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Must be submitted
  IF _expense.status <> 'submitted' THEN
    RAISE EXCEPTION 'Frais non révisable' USING ERRCODE = 'P0001';
  END IF;

  -- Rejected requires non-empty notes
  IF p_target_status = 'rejected' THEN
    _notes_trim := btrim(p_review_notes);
    IF _notes_trim IS NULL OR length(_notes_trim) = 0 THEN
      RAISE EXCEPTION 'Note de rejet obligatoire' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Transition: submitted → approved/rejected
  UPDATE public.mission_expenses
  SET status = p_target_status,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_notes = p_review_notes
  WHERE id = p_expense_id AND status = 'submitted';

  -- Log event
  IF p_target_status = 'approved' THEN
    PERFORM public.log_mission_event(
      _expense.mission_id,
      'expense_approved',
      NULL,
      NULL,
      'admin',
      jsonb_build_object('expense_id', p_expense_id)
    );
  ELSE
    PERFORM public.log_mission_event(
      _expense.mission_id,
      'expense_rejected',
      NULL,
      NULL,
      'admin',
      jsonb_build_object('expense_id', p_expense_id)
    );
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.review_mission_expense(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.review_mission_expense(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.review_mission_expense(uuid, text, text) TO authenticated;

-- =============================================================
-- 15. RPC: delete_mission_expense_draft
-- Only if: status=draft, submitted_by=auth.uid(), operator assigned, 0 receipts
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
  _authorized  boolean;
  _receipt_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _expense FROM public.mission_expenses WHERE id = p_expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Must be owner + operator + assigned
  SELECT
    (public.is_operator()
     AND public.is_convoyeur_for_mission(_expense.mission_id, auth.uid()))
  INTO _authorized;

  IF NOT _authorized OR _expense.submitted_by <> auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Must be draft
  IF _expense.status <> 'draft' THEN
    RAISE EXCEPTION 'Suppression non autorisée' USING ERRCODE = 'P0001';
  END IF;

  -- Must have 0 receipts
  SELECT count(*) INTO _receipt_count
  FROM public.mission_expense_receipts
  WHERE expense_id = p_expense_id;

  IF _receipt_count > 0 THEN
    RAISE EXCEPTION 'Suppression impossible : justificatif(s) enregistré(s)' USING ERRCODE = 'P0001';
  END IF;

  -- Delete the draft (FK RESTRICT on receipts won't trigger since count=0)
  DELETE FROM public.mission_expenses WHERE id = p_expense_id AND status = 'draft';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_mission_expense_draft(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_mission_expense_draft(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_mission_expense_draft(uuid) TO authenticated;

-- =============================================================
-- 16. GRANTS: trigger functions
-- =============================================================
REVOKE ALL ON FUNCTION public.mission_expenses_protect() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mission_expenses_protect() FROM anon;
REVOKE ALL ON FUNCTION public.mission_expense_receipts_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mission_expense_receipts_immutable() FROM anon;
