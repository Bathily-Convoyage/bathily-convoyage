-- =====================================================
-- Migration: phase3_b2_edl_evidence_hardening
-- Objectif : EDL immuables, preuves Storage, gates métier
-- =====================================================

BEGIN;

-- =========================================================
-- 1. EXTENSION TABLE edls (versioning / immuabilité)
-- =========================================================

ALTER TABLE public.edls
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS version int DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS supersedes_edl_id uuid,
  ADD COLUMN IF NOT EXISTS evidence_summary jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS correction_reason text;

ALTER TABLE public.edls
  ADD CONSTRAINT edls_version_check CHECK (version >= 1),
  ADD CONSTRAINT edls_supersedes_fk FOREIGN KEY (supersedes_edl_id) REFERENCES public.edls(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS edls_mission_version_idx ON public.edls(mission_id, type, version DESC);

-- =========================================================
-- 2. TABLE mission_evidence
-- =========================================================

CREATE TABLE IF NOT EXISTS public.mission_evidence (
  id              uuid DEFAULT gen_random_uuid() NOT NULL,
  mission_id      uuid NOT NULL REFERENCES public.missions(id) ON DELETE CASCADE,
  edl_id          uuid REFERENCES public.edls(id) ON DELETE CASCADE,
  evidence_type   text NOT NULL,
  storage_bucket  text NOT NULL,
  storage_path    text NOT NULL,
  mime_type       text,
  created_by      uuid,
  created_at      timestamptz DEFAULT now() NOT NULL,
  metadata        jsonb DEFAULT '{}'::jsonb,
  PRIMARY KEY (id)
);

ALTER TABLE public.mission_evidence OWNER TO "postgres";

CREATE INDEX IF NOT EXISTS mission_evidence_mission_idx ON public.mission_evidence(mission_id);
CREATE INDEX IF NOT EXISTS mission_evidence_edl_idx ON public.mission_evidence(edl_id);
CREATE INDEX IF NOT EXISTS mission_evidence_type_idx ON public.mission_evidence(mission_id, evidence_type);

-- =========================================================
-- 3. TRIGGERS IMMUABILITÉ
-- =========================================================

CREATE OR REPLACE FUNCTION public.edls_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'edls est strictement immutable : % interdit', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS edls_immutable_trigger ON public.edls;
CREATE TRIGGER edls_immutable_trigger
  BEFORE UPDATE OR DELETE ON public.edls
  FOR EACH ROW
  EXECUTE FUNCTION public.edls_immutable();

CREATE OR REPLACE FUNCTION public.mission_evidence_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'mission_evidence est strictement immutable : % interdit', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS mission_evidence_immutable_trigger ON public.mission_evidence;
CREATE TRIGGER mission_evidence_immutable_trigger
  BEFORE UPDATE OR DELETE ON public.mission_evidence
  FOR EACH ROW
  EXECUTE FUNCTION public.mission_evidence_immutable();

-- =========================================================
-- 4. RLS edls / mission_evidence
-- =========================================================

ALTER TABLE public.edls FORCE ROW LEVEL SECURITY;
ALTER TABLE public.edls ENABLE ROW LEVEL SECURITY;

-- Supprimer les anciennes policies permissives
DROP POLICY IF EXISTS "edls_delete_admin" ON public.edls;
DROP POLICY IF EXISTS "edls_delete_concerned" ON public.edls;
DROP POLICY IF EXISTS "edls_insert_authenticated" ON public.edls;
DROP POLICY IF EXISTS "edls_insert_concerned" ON public.edls;
DROP POLICY IF EXISTS "edls_select_concerned" ON public.edls;
DROP POLICY IF EXISTS "edls_select_own_or_admin" ON public.edls;
DROP POLICY IF EXISTS "edls_update_concerned" ON public.edls;
DROP POLICY IF EXISTS "edls_update_own_or_admin" ON public.edls;

-- SELECT : client concerné, convoyeur assigné, admin
CREATE POLICY "edls_select_client_b2" ON public.edls
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = edls.mission_id
        AND (
          m.client_id IN (SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid())
          OR m.client_email = (auth.jwt() ->> 'email')
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.missions m
      JOIN public.convoyeurs c ON c.id = m.convoyeur_id
      WHERE m.id = edls.mission_id AND c.auth_user_id = auth.uid()
    )
  );

-- Aucun INSERT/UPDATE/DELETE applicatif (passage par RPC SECURITY DEFINER)
REVOKE ALL ON public.edls FROM PUBLIC;
REVOKE ALL ON public.edls FROM anon;
REVOKE ALL ON public.edls FROM authenticated;
GRANT SELECT ON public.edls TO authenticated;
GRANT ALL ON public.edls TO postgres;

-- mission_evidence
ALTER TABLE public.mission_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE public.mission_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mission_evidence_select_client_b2" ON public.mission_evidence
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = mission_evidence.mission_id
        AND (
          m.client_id IN (SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid())
          OR m.client_email = (auth.jwt() ->> 'email')
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.missions m
      JOIN public.convoyeurs c ON c.id = m.convoyeur_id
      WHERE m.id = mission_evidence.mission_id AND c.auth_user_id = auth.uid()
    )
  );

REVOKE ALL ON public.mission_evidence FROM PUBLIC;
REVOKE ALL ON public.mission_evidence FROM anon;
REVOKE ALL ON public.mission_evidence FROM authenticated;
GRANT SELECT ON public.mission_evidence TO authenticated;
GRANT ALL ON public.mission_evidence TO postgres;

-- =========================================================
-- 5. FONCTIONS EDL
-- =========================================================

CREATE OR REPLACE FUNCTION public.latest_mission_edl(
  p_mission_id uuid,
  p_type text
)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT id
  FROM public.edls
  WHERE mission_id = p_mission_id
    AND type = p_type
  ORDER BY version DESC
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.latest_mission_edl(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.latest_mission_edl(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.mission_has_valid_edl(
  p_mission_id uuid,
  p_type text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.edls
    WHERE mission_id = p_mission_id
      AND type = p_type
      AND validated_at IS NOT NULL
    ORDER BY version DESC
    LIMIT 1
  );
$$;

REVOKE EXECUTE ON FUNCTION public.mission_has_valid_edl(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mission_has_valid_edl(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.validate_mission_edl(
  p_mission_id    uuid,
  p_edl_type      text,                 -- 'depart' ou 'arrivee'
  p_evidence      jsonb,                -- [{'type':'exterior_photo','bucket':'convoyeur-media','path':'...'}, ...]
  p_correction_of uuid DEFAULT NULL     -- si correction, référence l'EDL supersedé
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _convoyeur_id uuid;
  _convoyeur_auth uuid;
  _mission_status text;
  _expected_status text;
  _mission public.missions%ROWTYPE;
  _required_photos int := 5;
  _edl_id uuid;
  _version int := 1;
  _evidence_type text;
  _rec jsonb;
  _ext int := 0;
  _int int := 0;
  _client_sig int := 0;
  _conv_sig int := 0;
  _selfie int := 0;
BEGIN
  -- 1. Vérifier que le convoyeur appelant est celui assigné
  SELECT * INTO _mission
  FROM public.missions
  WHERE id = p_mission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0002';
  END IF;

  _mission_status := _mission.status;
  _convoyeur_id := _mission.convoyeur_id;

  SELECT auth_user_id INTO _convoyeur_auth
  FROM public.convoyeurs
  WHERE id = _convoyeur_id;

  IF _convoyeur_auth IS NULL OR _convoyeur_auth <> auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé : mission non assignée à ce convoyeur' USING ERRCODE = '42501';
  END IF;

  -- 2. Vérifier le statut mission
  _expected_status := CASE p_edl_type WHEN 'depart' THEN 'accepted' WHEN 'arrivee' THEN 'in_progress' END;
  IF _mission_status <> _expected_status THEN
    RAISE EXCEPTION 'Statut mission incorrect pour EDL % : % (attendu %)', p_edl_type, _mission_status, _expected_status
      USING ERRCODE = 'P0001';
  END IF;

  -- 3. Vérifier la validité des preuves Storage
  FOR _rec IN SELECT jsonb_array_elements(p_evidence)
  LOOP
    _evidence_type := _rec ->> 'type';
    IF _evidence_type NOT IN ('exterior_photo', 'interior_photo', 'client_signature', 'convoyeur_signature', 'delivery_selfie') THEN
      RAISE EXCEPTION 'Type de preuve inconnu : %', _evidence_type USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM storage.objects
      WHERE bucket_id = (_rec ->> 'bucket')
        AND name = (_rec ->> 'path')
    ) THEN
      RAISE EXCEPTION 'Preuve introuvable dans Storage : %/%', _rec ->> 'bucket', _rec ->> 'path'
        USING ERRCODE = 'P0002';
    END IF;

    -- Vérifier que le path appartient à la mission
    IF (_rec ->> 'path') !~ ('^missions/' || p_mission_id::text || '/') THEN
      RAISE EXCEPTION 'Le chemin de preuve n''appartient pas à la mission : %', _rec ->> 'path'
        USING ERRCODE = 'P0001';
    END IF;

    CASE _evidence_type
      WHEN 'exterior_photo' THEN _ext := _ext + 1;
      WHEN 'interior_photo' THEN _int := _int + 1;
      WHEN 'client_signature' THEN _client_sig := _client_sig + 1;
      WHEN 'convoyeur_signature' THEN _conv_sig := _conv_sig + 1;
      WHEN 'delivery_selfie' THEN _selfie := _selfie + 1;
    END CASE;
  END LOOP;

  -- 4. Vérifier les minimums
  IF _ext < _required_photos THEN
    RAISE EXCEPTION 'EDL % : photos extérieures insuffisantes (% < %)', p_edl_type, _ext, _required_photos
      USING ERRCODE = 'P0001';
  END IF;
  IF _int < _required_photos THEN
    RAISE EXCEPTION 'EDL % : photos intérieures insuffisantes (% < %)', p_edl_type, _int, _required_photos
      USING ERRCODE = 'P0001';
  END IF;
  IF _client_sig < 1 THEN
    RAISE EXCEPTION 'EDL % : signature client manquante', p_edl_type USING ERRCODE = 'P0001';
  END IF;
  IF _conv_sig < 1 THEN
    RAISE EXCEPTION 'EDL % : signature convoyeur manquante', p_edl_type USING ERRCODE = 'P0001';
  END IF;

  -- 5. Si arrivée, vérifier le selfie
  IF p_edl_type = 'arrivee' AND _selfie < 1 THEN
    RAISE EXCEPTION 'EDL arrivée : selfie final manquant' USING ERRCODE = 'P0001';
  END IF;

  -- 6. Déterminer la version
  IF p_correction_of IS NOT NULL THEN
    SELECT version + 1 INTO _version
    FROM public.edls
    WHERE id = p_correction_of;
  ELSE
    SELECT COALESCE(MAX(version), 0) + 1 INTO _version
    FROM public.edls
    WHERE mission_id = p_mission_id AND type = p_edl_type;
  END IF;

  -- 7. Créer l'EDL
  INSERT INTO public.edls (
    mission_id,
    reference,
    type,
    convoyeur_nom,
    date_heure,
    conforme,
    created_by,
    validated_at,
    version,
    supersedes_edl_id,
    evidence_summary,
    correction_reason,
    photos,
    signatures,
    photo_fin_mission
  ) VALUES (
    p_mission_id,
    'EDL-' || p_mission_id::text || '-' || p_edl_type || '-v' || _version,
    p_edl_type,
    _mission.convoyeur_nom,
    now(),
    true,
    auth.uid(),
    now(),
    _version,
    p_correction_of,
    jsonb_build_object(
      'exterior_photo', _ext,
      'interior_photo', _int,
      'client_signature', _client_sig,
      'convoyeur_signature', _conv_sig,
      'delivery_selfie', _selfie
    ),
    CASE WHEN p_correction_of IS NOT NULL THEN 'Correction EDL' END,
    '{}'::jsonb,
    '{}'::jsonb,
    NULL
  )
  RETURNING id INTO _edl_id;

  -- 8. Créer mission_evidence
  FOR _rec IN SELECT jsonb_array_elements(p_evidence)
  LOOP
    INSERT INTO public.mission_evidence (
      mission_id,
      edl_id,
      evidence_type,
      storage_bucket,
      storage_path,
      mime_type,
      created_by,
      metadata
    ) VALUES (
      p_mission_id,
      _edl_id,
      _rec ->> 'type',
      _rec ->> 'bucket',
      _rec ->> 'path',
      _rec ->> 'mime',
      auth.uid(),
      COALESCE(_rec -> 'metadata', '{}'::jsonb)
    );
  END LOOP;

  -- 9. Logger l'événement EDL
  PERFORM public.log_mission_event(
    p_mission_id,
    CASE p_edl_type
      WHEN 'depart' THEN 'edl_departure_validated'
      WHEN 'arrivee' THEN 'edl_arrival_validated'
      ELSE 'edl_validated'
    END,
    _expected_status,
    _expected_status,
    'convoyeur',
    jsonb_build_object(
      'edl_id', _edl_id,
      'edl_version', _version,
      'evidence', p_evidence
    )
  );

  RETURN _edl_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid) TO authenticated;

-- =========================================================
-- 6. GATES TRANSITION MISSION
-- =========================================================

CREATE OR REPLACE FUNCTION public.transition_mission_status(
  p_mission_id    uuid,
  p_target_status text,
  p_reason        text DEFAULT NULL,
  p_metadata      jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _current_status text;
  _is_admin       boolean := public.is_admin();
  _is_operator    boolean := public.is_operator();
  _is_convoyeur   boolean;
  _mission        public.missions%ROWTYPE;
  _allowed        boolean := false;
  _actor_role     text;
  _event_type     text;
BEGIN
  SELECT * INTO _mission
  FROM public.missions
  WHERE id = p_mission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  _current_status := _mission.status;

  IF NOT public.mission_can_transition(_current_status, p_target_status) THEN
    RAISE EXCEPTION 'Transition interdite : % -> %', _current_status, p_target_status
      USING ERRCODE = 'P0001';
  END IF;

  _is_convoyeur := public.is_convoyeur_for_mission(p_mission_id, auth.uid());

  IF _is_admin OR _is_operator THEN
    _actor_role := 'admin';
    _allowed := (
      (_current_status = 'available'   AND p_target_status = 'assigned')
      OR (_current_status = 'assigned'  AND p_target_status IN ('available', 'cancelled'))
      OR (_current_status = 'accepted'  AND p_target_status = 'cancelled')
      OR (_current_status = 'in_progress' AND p_target_status = 'cancelled')
      OR (_current_status = 'delivered' AND p_target_status = 'completed')
      OR (_current_status = 'completed' AND p_target_status = 'archived')
      OR (_current_status = 'cancelled' AND p_target_status = 'archived')
    );

  ELSIF _is_convoyeur THEN
    _actor_role := 'convoyeur';
    _allowed := (
      (_current_status = 'assigned'   AND p_target_status IN ('accepted', 'available'))
      OR (_current_status = 'accepted'  AND p_target_status = 'in_progress')
      OR (_current_status = 'in_progress' AND p_target_status = 'delivered')
    );

  ELSE
    RAISE EXCEPTION 'Non autorisé'
      USING ERRCODE = '42501';
  END IF;

  IF NOT _allowed THEN
    RAISE EXCEPTION 'Transition % -> % non autorisée pour ce rôle', _current_status, p_target_status
      USING ERRCODE = '42501';
  END IF;

  -- Gates EDL
  IF _current_status = 'accepted' AND p_target_status = 'in_progress' THEN
    IF NOT public.mission_has_valid_edl(p_mission_id, 'depart') THEN
      RAISE EXCEPTION 'EDL départ non validé'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF _current_status = 'in_progress' AND p_target_status = 'delivered' THEN
    IF NOT public.mission_has_valid_edl(p_mission_id, 'arrivee') THEN
      RAISE EXCEPTION 'EDL arrivée non validé'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.missions
  SET status = p_target_status,
      updated_at = now()
  WHERE id = p_mission_id;

  _event_type := public.mission_event_name(_current_status, p_target_status);

  PERFORM public.log_mission_event(
    p_mission_id,
    _event_type,
    _current_status,
    p_target_status,
    _actor_role,
    jsonb_build_object(
      'reason', p_reason,
      'metadata', p_metadata
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.transition_mission_status(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_mission_status(uuid, text, text, jsonb) TO authenticated;

-- =========================================================
-- 7. MISE À JOUR mission_event_name POUR EDL
-- =========================================================

CREATE OR REPLACE FUNCTION public.mission_event_name(
  p_from text,
  p_to text
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_from = 'available'   AND p_to = 'assigned'   THEN 'mission_assigned'
    WHEN p_from = 'assigned'    AND p_to = 'accepted'   THEN 'assignment_accepted'
    WHEN p_from = 'assigned'    AND p_to = 'available'  THEN 'assignment_rejected'
    WHEN p_from = 'accepted'    AND p_to = 'in_progress' THEN 'mission_started'
    WHEN p_from = 'in_progress' AND p_to = 'delivered'  THEN 'mission_delivered'
    WHEN p_from = 'delivered'   AND p_to = 'completed'  THEN 'mission_completed'
    WHEN p_from = 'completed'   AND p_to = 'archived'   THEN 'mission_archived'
    WHEN p_from = 'cancelled'   AND p_to = 'archived'   THEN 'mission_archived'
    WHEN p_from IN ('available','assigned','accepted','in_progress','delivered')
         AND p_to = 'cancelled' THEN 'mission_cancelled'
    ELSE 'mission_status_changed'
  END;
$$;

COMMIT;
