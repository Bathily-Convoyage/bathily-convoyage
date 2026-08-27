-- P4.2b: let a confirmed, non-banned convoyeur execute only missions that an
-- administrator or operator explicitly assigned to their Auth-linked profile.
-- The external-convoyeur marketplace flag remains unchanged and continues to
-- gate available missions, candidatures, self-registration, and community use.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Assigned mission visibility is an ownership rule. The separate available
-- mission branch deliberately keeps the global rollout gate.
ALTER POLICY "missions_select_b3" ON public.missions
  USING (
    public.is_admin()
    OR public.is_operator()
    OR client_id IN (
      SELECT c.id
      FROM public.clients c
      WHERE c.auth_user_id = (select auth.uid())
    )
    OR client_email = ((select auth.jwt()) ->> 'email')
    OR convoyeur_id IN (
      SELECT c.id
      FROM public.convoyeurs c
      WHERE c.auth_user_id = (select auth.uid())
        AND c.banned = false
    )
    OR (
      status = 'available'
      AND (
        public.is_internal_user()
        OR public.external_convoyeurs_enabled()
      )
    )
  );

-- An assigned convoyeur needs the EDL, event, and evidence rows belonging to
-- the same mission. Client and admin branches are preserved.
ALTER POLICY "edls_select_client_b2" ON public.edls
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.missions m
      WHERE m.id = edls.mission_id
        AND (
          m.client_id IN (
            SELECT c.id
            FROM public.clients c
            WHERE c.auth_user_id = (select auth.uid())
          )
          OR m.client_email = ((select auth.jwt()) ->> 'email')
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.missions m
      JOIN public.convoyeurs c ON c.id = m.convoyeur_id
      WHERE m.id = edls.mission_id
        AND c.auth_user_id = (select auth.uid())
        AND c.banned = false
    )
  );

ALTER POLICY "mission_events_convoyeur_select_b2" ON public.mission_events
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.missions m
      JOIN public.convoyeurs c ON c.id = m.convoyeur_id
      WHERE m.id = mission_events.mission_id
        AND c.auth_user_id = (select auth.uid())
        AND c.banned = false
    )
  );

ALTER POLICY "mission_evidence_select_client_b2" ON public.mission_evidence
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.missions m
      WHERE m.id = mission_evidence.mission_id
        AND (
          m.client_id IN (
            SELECT c.id
            FROM public.clients c
            WHERE c.auth_user_id = (select auth.uid())
          )
          OR m.client_email = ((select auth.jwt()) ->> 'email')
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.missions m
      JOIN public.convoyeurs c ON c.id = m.convoyeur_id
      WHERE m.id = mission_evidence.mission_id
        AND c.auth_user_id = (select auth.uid())
        AND c.banned = false
    )
  );

-- Storage access is restricted to the UUID path of an owned mission. No
-- generic bucket access is introduced.
ALTER POLICY "convoyeur_media_select_mission_concerned" ON storage.objects
  USING (
    bucket_id = 'convoyeur-media'
    AND name ~ '^missions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
    AND EXISTS (
      SELECT 1
      FROM public.missions m
      WHERE m.id::text = split_part(storage.objects.name, '/', 2)
        AND (
          m.client_id IN (
            SELECT c.id
            FROM public.clients c
            WHERE c.auth_user_id = (select auth.uid())
          )
          OR EXISTS (
            SELECT 1
            FROM public.convoyeurs cv
            WHERE cv.id = m.convoyeur_id
              AND cv.auth_user_id = (select auth.uid())
              AND cv.banned = false
          )
        )
    )
  );

ALTER POLICY "convoyeur_media_insert_missions_b2v" ON storage.objects
  WITH CHECK (
    bucket_id = 'convoyeur-media'
    AND name ~ '^missions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.missions m
        JOIN public.convoyeurs cv ON cv.id = m.convoyeur_id
        WHERE m.id::text = split_part(storage.objects.name, '/', 2)
          AND cv.auth_user_id = (select auth.uid())
          AND cv.banned = false
      )
    )
  );

-- Explicit assignment is the trust boundary while the marketplace remains
-- closed. The target profile must map to a live, confirmed, non-banned Auth
-- account and must itself not be banned.
CREATE OR REPLACE FUNCTION public.admin_assign_mission(
  p_mission_id uuid,
  p_convoyeur_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  _mission public.missions%ROWTYPE;
  _convoyeur public.convoyeurs%ROWTYPE;
  _current_status text;
BEGIN
  IF NOT (public.is_admin() OR public.is_operator()) THEN
    RAISE EXCEPTION 'Non autorisé'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _mission
  FROM public.missions
  WHERE id = p_mission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  _current_status := _mission.status;

  IF _current_status <> 'available' THEN
    RAISE EXCEPTION 'Mission non disponible : statut %', _current_status
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO _convoyeur
  FROM public.convoyeurs
  WHERE id = p_convoyeur_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Convoyeur introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  IF _convoyeur.auth_user_id IS NULL OR coalesce(_convoyeur.banned, true) THEN
    RAISE EXCEPTION 'Convoyeur non éligible à une affectation'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE u.id = _convoyeur.auth_user_id
      AND u.deleted_at IS NULL
      AND u.confirmed_at IS NOT NULL
      AND (u.banned_until IS NULL OR u.banned_until <= now())
  ) THEN
    RAISE EXCEPTION 'Compte Auth du convoyeur inactif, non confirmé ou banni'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.missions
  SET convoyeur_id = p_convoyeur_id,
      convoyeur_nom = _convoyeur.prenom || ' ' || _convoyeur.nom,
      status = 'assigned',
      updated_at = now()
  WHERE id = p_mission_id;

  PERFORM public.log_mission_event(
    p_mission_id,
    'mission_assigned',
    _current_status,
    'assigned',
    'admin',
    jsonb_build_object(
      'convoyeur_id', p_convoyeur_id,
      'convoyeur_nom', _convoyeur.prenom || ' ' || _convoyeur.nom
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.respond_mission_assignment(
  p_mission_id uuid,
  p_accepted boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  _mission public.missions%ROWTYPE;
  _current_status text;
  _caller_user_id uuid := auth.uid();
BEGIN
  IF _caller_user_id IS NULL
    OR NOT public.is_convoyeur_for_mission(p_mission_id, _caller_user_id)
    OR NOT EXISTS (
      SELECT 1
      FROM public.convoyeurs c
      WHERE c.auth_user_id = _caller_user_id
        AND c.banned = false
    )
  THEN
    RAISE EXCEPTION 'Non autorisé'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _mission
  FROM public.missions
  WHERE id = p_mission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  _current_status := _mission.status;

  IF _current_status <> 'assigned' THEN
    RAISE EXCEPTION 'Mission non assignée : %', _current_status
      USING ERRCODE = 'P0001';
  END IF;

  IF p_accepted THEN
    UPDATE public.missions
    SET status = 'accepted',
        updated_at = now()
    WHERE id = p_mission_id;

    PERFORM public.log_mission_event(
      p_mission_id,
      'assignment_accepted',
      _current_status,
      'accepted',
      'convoyeur',
      '{}'::jsonb
    );
  ELSE
    UPDATE public.missions
    SET convoyeur_id = NULL,
        convoyeur_nom = NULL,
        status = 'available',
        updated_at = now()
    WHERE id = p_mission_id;

    PERFORM public.log_mission_event(
      p_mission_id,
      'assignment_rejected',
      _current_status,
      'available',
      'convoyeur',
      '{}'::jsonb
    );
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.transition_mission_status(
  p_mission_id uuid,
  p_target_status text,
  p_reason text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  _current_status text;
  _is_admin boolean := public.is_admin();
  _is_operator boolean := public.is_operator();
  _is_convoyeur boolean;
  _mission public.missions%ROWTYPE;
  _allowed_gestion boolean := false;
  _allowed_execution boolean := false;
  _allowed boolean := false;
  _actor_role text;
  _event_type text;
  _caller_user_id uuid := auth.uid();
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

  _is_convoyeur := _caller_user_id IS NOT NULL
    AND public.is_convoyeur_for_mission(p_mission_id, _caller_user_id)
    AND EXISTS (
      SELECT 1
      FROM public.convoyeurs c
      WHERE c.auth_user_id = _caller_user_id
        AND c.banned = false
    );

  IF _is_admin OR _is_operator THEN
    _allowed_gestion := (
      (_current_status = 'available' AND p_target_status = 'assigned')
      OR (_current_status = 'assigned' AND p_target_status IN ('available', 'cancelled'))
      OR (_current_status = 'accepted' AND p_target_status = 'cancelled')
      OR (_current_status = 'in_progress' AND p_target_status = 'cancelled')
      OR (_current_status = 'delivered' AND p_target_status = 'completed')
      OR (_current_status = 'completed' AND p_target_status = 'archived')
      OR (_current_status = 'cancelled' AND p_target_status = 'archived')
    );
  END IF;

  IF _is_convoyeur THEN
    _allowed_execution := (
      (_current_status = 'assigned' AND p_target_status IN ('accepted', 'available'))
      OR (_current_status = 'accepted' AND p_target_status = 'in_progress')
      OR (_current_status = 'in_progress' AND p_target_status = 'delivered')
    );
  END IF;

  _allowed := _allowed_gestion OR _allowed_execution;

  IF NOT _allowed THEN
    IF _is_admin OR _is_operator OR _is_convoyeur THEN
      RAISE EXCEPTION 'Transition % -> % non autorisée pour ce rôle', _current_status, p_target_status
        USING ERRCODE = '42501';
    ELSE
      RAISE EXCEPTION 'Non autorisé'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF _current_status = 'accepted' AND p_target_status = 'in_progress' THEN
    IF NOT public.mission_has_valid_edl(p_mission_id, 'depart') THEN
      RAISE EXCEPTION 'L''état des lieux de départ doit être validé avant de démarrer la mission.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF _current_status = 'in_progress' AND p_target_status = 'delivered' THEN
    IF NOT public.mission_has_valid_edl(p_mission_id, 'arrivee') THEN
      RAISE EXCEPTION 'L''état des lieux d''arrivée doit être validé avant de livrer la mission.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF _allowed_execution AND NOT _allowed_gestion THEN
    _actor_role := 'convoyeur';
  ELSIF _allowed_gestion AND NOT _allowed_execution THEN
    _actor_role := 'admin';
  ELSIF _allowed_execution AND _allowed_gestion THEN
    _actor_role := 'operator';
  ELSE
    _actor_role := 'admin';
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
$function$;

CREATE OR REPLACE FUNCTION public.validate_mission_edl(
  p_mission_id uuid,
  p_edl_type text,
  p_evidence jsonb,
  p_correction_of uuid DEFAULT NULL,
  p_correction_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  _convoyeur_id uuid;
  _convoyeur_auth uuid;
  _convoyeur_banned boolean;
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
  _obj record;
  _caller_user_id uuid := auth.uid();
BEGIN
  SELECT * INTO _mission
  FROM public.missions
  WHERE id = p_mission_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0002';
  END IF;

  _mission_status := _mission.status;
  _convoyeur_id := _mission.convoyeur_id;

  SELECT auth_user_id, banned
  INTO _convoyeur_auth, _convoyeur_banned
  FROM public.convoyeurs
  WHERE id = _convoyeur_id;

  IF _caller_user_id IS NULL
    OR _convoyeur_auth IS NULL
    OR _convoyeur_auth IS DISTINCT FROM _caller_user_id
    OR coalesce(_convoyeur_banned, true)
  THEN
    RAISE EXCEPTION 'Non autorisé : mission non assignée à ce convoyeur' USING ERRCODE = '42501';
  END IF;

  _expected_status := CASE p_edl_type WHEN 'depart' THEN 'accepted' WHEN 'arrivee' THEN 'in_progress' END;
  IF _mission_status <> _expected_status THEN
    RAISE EXCEPTION 'Statut mission incorrect pour EDL % : % (attendu %)', p_edl_type, _mission_status, _expected_status
      USING ERRCODE = 'P0001';
  END IF;

  IF p_correction_of IS NOT NULL AND (p_correction_reason IS NULL OR btrim(p_correction_reason) = '') THEN
    RAISE EXCEPTION 'correction_reason est requis pour une correction d''EDL' USING ERRCODE = 'P0001';
  END IF;

  IF p_correction_of IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.edls
      WHERE id = p_correction_of
        AND mission_id = p_mission_id
        AND type = p_edl_type
    ) THEN
      RAISE EXCEPTION 'EDL à corriger introuvable ou type incorrect' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  FOR _rec IN SELECT jsonb_array_elements(p_evidence)
  LOOP
    _evidence_type := _rec ->> 'type';
    IF _evidence_type NOT IN ('exterior_photo', 'interior_photo', 'client_signature', 'convoyeur_signature', 'delivery_selfie') THEN
      RAISE EXCEPTION 'Type de preuve inconnu : %', _evidence_type USING ERRCODE = 'P0001';
    END IF;

    SELECT id, owner INTO _obj
    FROM storage.objects
    WHERE bucket_id = (_rec ->> 'bucket')
      AND name = (_rec ->> 'path');

    IF _obj.id IS NULL THEN
      RAISE EXCEPTION 'Preuve introuvable dans Storage : %/%', _rec ->> 'bucket', _rec ->> 'path'
        USING ERRCODE = 'P0002';
    END IF;

    IF (_rec ->> 'path') !~ ('^missions/' || p_mission_id::text || '/') THEN
      RAISE EXCEPTION 'Le chemin de preuve n''appartient pas à la mission : %', _rec ->> 'path'
        USING ERRCODE = 'P0001';
    END IF;

    IF _obj.owner IS NULL OR _obj.owner IS DISTINCT FROM _caller_user_id THEN
      RAISE EXCEPTION 'La preuve % n''a pas été uploadée par le convoyeur assigné', _rec ->> 'path'
        USING ERRCODE = '42501';
    END IF;

    CASE _evidence_type
      WHEN 'exterior_photo' THEN _ext := _ext + 1;
      WHEN 'interior_photo' THEN _int := _int + 1;
      WHEN 'client_signature' THEN _client_sig := _client_sig + 1;
      WHEN 'convoyeur_signature' THEN _conv_sig := _conv_sig + 1;
      WHEN 'delivery_selfie' THEN _selfie := _selfie + 1;
    END CASE;
  END LOOP;

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

  IF p_edl_type = 'arrivee' AND _selfie < 1 THEN
    RAISE EXCEPTION 'EDL arrivée : selfie final manquant' USING ERRCODE = 'P0001';
  END IF;

  IF p_correction_of IS NOT NULL THEN
    SELECT version + 1 INTO _version
    FROM public.edls
    WHERE id = p_correction_of;
  ELSE
    SELECT COALESCE(MAX(version), 0) + 1 INTO _version
    FROM public.edls
    WHERE mission_id = p_mission_id AND type = p_edl_type;
  END IF;

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
    _caller_user_id,
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
    p_correction_reason,
    '{}'::jsonb,
    '{}'::jsonb,
    NULL
  )
  RETURNING id INTO _edl_id;

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
      _caller_user_id,
      COALESCE(_rec -> 'metadata', '{}'::jsonb)
    );
  END LOOP;

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
$function$;

CREATE OR REPLACE FUNCTION public.authorize_gps_session(p_mission_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  _convoyeur uuid;
  _status text;
  _caller_user_id uuid := auth.uid();
BEGIN
  SELECT convoyeur_id, status
  INTO _convoyeur, _status
  FROM public.missions
  WHERE id = p_mission_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF _status <> 'in_progress' THEN
    RAISE EXCEPTION 'Statut mission invalide pour GPS : %', _status USING ERRCODE = 'P0001';
  END IF;

  IF _caller_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.convoyeurs c
    WHERE c.id = _convoyeur
      AND c.auth_user_id = _caller_user_id
      AND c.banned = false
  ) THEN
    RAISE EXCEPTION 'Convoyeur non assigné' USING ERRCODE = '42501';
  END IF;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_gps_position(
  p_mission_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision DEFAULT NULL,
  p_speed double precision DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  _convoyeur uuid;
  _status text;
  _pos_id uuid;
  _caller_user_id uuid := auth.uid();
BEGIN
  SELECT convoyeur_id, status
  INTO _convoyeur, _status
  FROM public.missions
  WHERE id = p_mission_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF _status <> 'in_progress' THEN
    RAISE EXCEPTION 'Statut mission invalide pour GPS : %', _status USING ERRCODE = 'P0001';
  END IF;

  IF _caller_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.convoyeurs c
    WHERE c.id = _convoyeur
      AND c.auth_user_id = _caller_user_id
      AND c.banned = false
  ) THEN
    RAISE EXCEPTION 'Convoyeur non assigné' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.mission_gps_positions (
    mission_id,
    lat,
    lng,
    accuracy,
    speed,
    recorded_at,
    created_by
  ) VALUES (
    p_mission_id,
    p_lat,
    p_lng,
    p_accuracy,
    p_speed,
    now(),
    _caller_user_id
  )
  RETURNING id INTO _pos_id;

  RETURN _pos_id;
END;
$function$;

-- Re-freeze the P3.5 ACL after replacing these SECURITY DEFINER workflows.
ALTER FUNCTION public.admin_assign_mission(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.respond_mission_assignment(uuid, boolean) OWNER TO postgres;
ALTER FUNCTION public.transition_mission_status(uuid, text, text, jsonb) OWNER TO postgres;
ALTER FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid, text) OWNER TO postgres;
ALTER FUNCTION public.authorize_gps_session(uuid) OWNER TO postgres;
ALTER FUNCTION public.record_gps_position(uuid, double precision, double precision, double precision, double precision) OWNER TO postgres;

REVOKE EXECUTE ON FUNCTION public.admin_assign_mission(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.respond_mission_assignment(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.transition_mission_status(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.authorize_gps_session(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.record_gps_position(uuid, double precision, double precision, double precision, double precision) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_assign_mission(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.respond_mission_assignment(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transition_mission_status(uuid, text, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.authorize_gps_session(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_gps_position(uuid, double precision, double precision, double precision, double precision) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
