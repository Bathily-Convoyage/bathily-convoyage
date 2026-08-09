-- =====================================================
-- Migration: phase3_b3v_gps_tracking_notifications_final
-- Objectif : mode lancement interne, tracking tokenisé, notifications
-- =====================================================

BEGIN;

-- =========================================================
-- 1. APP_SETTINGS + FEATURE FLAG
-- =========================================================

CREATE TABLE IF NOT EXISTS public.app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

COMMENT ON TABLE public.app_settings IS 'Configuration serveur persistante.';

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_settings_select_b3v" ON public.app_settings;
CREATE POLICY "app_settings_select_b3v" ON public.app_settings
  FOR SELECT
  TO authenticated
  USING (public.is_admin() OR public.is_operator());

DROP POLICY IF EXISTS "app_settings_update_b3v" ON public.app_settings;
CREATE POLICY "app_settings_update_b3v" ON public.app_settings
  FOR UPDATE
  TO authenticated
  USING (public.is_admin() OR public.is_operator())
  WITH CHECK (public.is_admin() OR public.is_operator());

INSERT INTO public.app_settings (key, value)
VALUES ('external_convoyeurs_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- =========================================================
-- 2. HELPERS INTERNES / EXTERNES
-- =========================================================

CREATE OR REPLACE FUNCTION public.is_internal_user()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.is_admin() OR public.is_operator();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.is_internal_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_internal_user() TO authenticated;

CREATE OR REPLACE FUNCTION public.external_convoyeurs_enabled()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _val jsonb;
BEGIN
  SELECT value INTO _val FROM public.app_settings WHERE key = 'external_convoyeurs_enabled';
  RETURN COALESCE((_val ->> 'value')::boolean, _val::boolean, false);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.external_convoyeurs_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.external_convoyeurs_enabled() TO authenticated;

-- =========================================================
-- 3. CANDIDATURES BLOQUÉES SI EXTERNE DÉSACTIVÉ
-- =========================================================

DROP POLICY IF EXISTS "candidatures_insert_own_b1" ON public.candidatures;

CREATE POLICY "candidatures_insert_b3v" ON public.candidatures
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_internal_user()
    OR public.external_convoyeurs_enabled()
  );

-- =========================================================
-- 4. ADMIN_ASSIGN_MISSION VÉRIFIE INTERNE
-- =========================================================

CREATE OR REPLACE FUNCTION public.admin_assign_mission(
  p_mission_id    uuid,
  p_convoyeur_id  uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _mission public.missions%ROWTYPE;
  _convoyeur public.convoyeurs%ROWTYPE;
  _current_status text;
  _is_internal boolean;
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

  _is_internal := EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _convoyeur.auth_user_id
      AND ur.role IN ('admin','operator')
  );

  IF NOT public.external_convoyeurs_enabled() AND NOT _is_internal THEN
    RAISE EXCEPTION 'Convoyeurs externes désactivés. Attribuer un exécutant interne.'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.missions
  SET convoyeur_id   = p_convoyeur_id,
      convoyeur_nom  = _convoyeur.prenom || ' ' || _convoyeur.nom,
      status         = 'assigned',
      updated_at     = now()
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
$$;

REVOKE EXECUTE ON FUNCTION public.admin_assign_mission(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_assign_mission(uuid, uuid) TO authenticated;

-- =========================================================
-- 5. RESPOND_MISSION_ASSIGNMENT BLOQUE EXTERNE SI DÉSACTIVÉ
-- =========================================================

CREATE OR REPLACE FUNCTION public.respond_mission_assignment(
  p_mission_id   uuid,
  p_accepted     boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _mission public.missions%ROWTYPE;
  _current_status text;
BEGIN
  IF NOT public.is_convoyeur_for_mission(p_mission_id, auth.uid()) THEN
    RAISE EXCEPTION 'Non autorisé'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_internal_user() AND NOT public.external_convoyeurs_enabled() THEN
    RAISE EXCEPTION 'Convoyeurs externes désactivés.'
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
    SET convoyeur_id  = NULL,
        convoyeur_nom = NULL,
        status        = 'available',
        updated_at    = now()
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
$$;

REVOKE EXECUTE ON FUNCTION public.respond_mission_assignment(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_mission_assignment(uuid, boolean) TO authenticated;

-- =========================================================
-- 6. VALIDATE_MISSION_EDL BLOQUE EXTERNE SI DÉSACTIVÉ
-- =========================================================

CREATE OR REPLACE FUNCTION public.validate_mission_edl(
  p_mission_id        uuid,
  p_edl_type          text,
  p_evidence          jsonb,
  p_correction_of     uuid DEFAULT NULL,
  p_correction_reason text DEFAULT NULL
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
  _obj record;
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

  SELECT auth_user_id INTO _convoyeur_auth
  FROM public.convoyeurs
  WHERE id = _convoyeur_id;

  IF _convoyeur_auth IS NULL OR _convoyeur_auth IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé : mission non assignée à ce convoyeur' USING ERRCODE = '42501';
  END IF;

  -- Mode lancement : bloquer les convoyeurs externes
  IF NOT public.is_internal_user() AND NOT public.external_convoyeurs_enabled() THEN
    RAISE EXCEPTION 'Convoyeurs externes désactivés.' USING ERRCODE = '42501';
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

    IF _obj.owner IS NULL OR _obj.owner IS DISTINCT FROM auth.uid() THEN
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
      auth.uid(),
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
$$;

REVOKE EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.validate_mission_edl(uuid, text, jsonb, uuid, text) TO authenticated;

-- =========================================================
-- 7. GPS BLOQUE EXTERNE SI DÉSACTIVÉ
-- =========================================================

CREATE OR REPLACE FUNCTION public.authorize_gps_session(p_mission_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _convoyeur uuid;
  _status text;
BEGIN
  IF NOT public.is_internal_user() AND NOT public.external_convoyeurs_enabled() THEN
    RAISE EXCEPTION 'Convoyeurs externes désactivés.'
      USING ERRCODE = '42501';
  END IF;

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

  IF NOT EXISTS (
    SELECT 1 FROM public.convoyeurs c
    WHERE c.id = _convoyeur AND c.auth_user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Convoyeur non assigné' USING ERRCODE = '42501';
  END IF;

  RETURN true;
END;
$$;

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
SET search_path = ''
AS $$
DECLARE
  _convoyeur uuid;
  _status text;
  _pos_id uuid;
BEGIN
  IF NOT public.is_internal_user() AND NOT public.external_convoyeurs_enabled() THEN
    RAISE EXCEPTION 'Convoyeurs externes désactivés.'
      USING ERRCODE = '42501';
  END IF;

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

  IF NOT EXISTS (
    SELECT 1 FROM public.convoyeurs c
    WHERE c.id = _convoyeur AND c.auth_user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Convoyeur non assigné' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.mission_gps_positions (mission_id, lat, lng, accuracy, speed, recorded_at, created_by)
  VALUES (p_mission_id, p_lat, p_lng, p_accuracy, p_speed, now(), auth.uid())
  RETURNING id INTO _pos_id;

  RETURN _pos_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_gps_position(uuid, double precision, double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_gps_position(uuid, double precision, double precision, double precision, double precision) TO authenticated;

-- =========================================================
-- 8. OUTBOX IDEMPOTENCE
-- =========================================================

ALTER TABLE public.notification_outbox
  ADD CONSTRAINT notification_outbox_unique_event
  UNIQUE (mission_event_id, notification_type, recipient_type);

-- =========================================================
-- 9. CONSUMER NOTIFICATIONS (RPC)
-- =========================================================

CREATE OR REPLACE FUNCTION public.process_notification_outbox(
  p_limit int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  status text,
  attempts int,
  last_error text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _row public.notification_outbox%ROWTYPE;
  _mission public.missions%ROWTYPE;
  _client public.clients%ROWTYPE;
  _convoyeur public.convoyeurs%ROWTYPE;
  _to_email text;
  _subject text;
  _body text;
BEGIN
  IF NOT (public.is_admin() OR public.is_operator()) THEN
    RAISE EXCEPTION 'Non autorisé'
      USING ERRCODE = '42501';
  END IF;

  FOR _row IN
    SELECT no.*
    FROM public.notification_outbox no
    WHERE no.status IN ('pending', 'retry')
    ORDER BY no.created_at
    FOR UPDATE OF no SKIP LOCKED
    LIMIT p_limit
  LOOP
    BEGIN
      SELECT * INTO _mission FROM public.missions m WHERE m.id = _row.mission_id;
      _to_email := NULL;

      IF _row.recipient_type = 'client' AND _mission.client_id IS NOT NULL THEN
        SELECT * INTO _client FROM public.clients c WHERE c.id = _mission.client_id;
        _to_email := _client.email;
      ELSIF _row.recipient_type = 'convoyeur' AND _mission.convoyeur_id IS NOT NULL THEN
        SELECT * INTO _convoyeur FROM public.convoyeurs c WHERE c.id = _mission.convoyeur_id;
        _to_email := _convoyeur.email;
      END IF;

      IF _to_email IS NULL THEN
        UPDATE public.notification_outbox AS no
        SET status = 'failed', attempts = no.attempts + 1, last_error = 'Destinataire introuvable'
        WHERE no.id = _row.id;
      ELSE
        _subject := CASE _row.notification_type
          WHEN 'mission_assigned' THEN 'Votre mission est assignée'
          WHEN 'assignment_accepted' THEN 'Mission acceptée par l''exécutant'
          WHEN 'assignment_rejected' THEN 'Mission refusée par l''exécutant'
          WHEN 'edl_departure_validated' THEN 'Départ confirmé'
          WHEN 'mission_started' THEN 'Mission en cours'
          WHEN 'edl_arrival_validated' THEN 'Arrivée confirmée'
          WHEN 'mission_delivered' THEN 'Mission livrée'
          WHEN 'mission_cancelled' THEN 'Mission annulée'
          ELSE 'Notification mission'
        END;

        _body := CASE _row.notification_type
          WHEN 'mission_assigned' THEN '<p>Votre mission ' || _mission.reference || ' a été assignée.</p>'
          WHEN 'edl_departure_validated' THEN '<p>Le départ de la mission ' || _mission.reference || ' est confirmé.</p>'
          WHEN 'mission_started' THEN '<p>La mission ' || _mission.reference || ' est en cours.</p>'
          WHEN 'edl_arrival_validated' THEN '<p>L''arrivée de la mission ' || _mission.reference || ' est confirmée.</p>'
          WHEN 'mission_delivered' THEN '<p>La mission ' || _mission.reference || ' est livrée.</p>'
          WHEN 'mission_cancelled' THEN '<p>La mission ' || _mission.reference || ' est annulée.</p>'
          ELSE '<p>Notification concernant la mission ' || _mission.reference || '</p>'
        END;

        UPDATE public.notification_outbox AS no
        SET status = 'prepared', attempts = no.attempts + 1, sent_at = now(), last_error = NULL,
            payload = _row.payload || jsonb_build_object('to', _to_email, 'subject', _subject, 'body', _body)
        WHERE no.id = _row.id;
      END IF;

      RETURN QUERY SELECT _row.id, 'sent', _row.attempts + 1, NULL::text;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.notification_outbox AS no
      SET status = 'failed', attempts = no.attempts + 1, last_error = SQLERRM
      WHERE no.id = _row.id;
      RETURN QUERY SELECT _row.id, 'failed', _row.attempts + 1, SQLERRM;
    END;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_notification_outbox(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_notification_outbox(int) TO authenticated;

-- =========================================================
-- 10. TRACKING TOKEN — CRÉATION RESTREINTE
-- =========================================================

CREATE OR REPLACE FUNCTION public.create_tracking_token(p_mission_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _token text;
  _hash text;
  _mission_status text;
BEGIN
  IF NOT (public.is_admin() OR public.is_operator()) THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO _mission_status
  FROM public.missions
  WHERE id = p_mission_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF _mission_status NOT IN ('accepted','in_progress','delivered') THEN
    RAISE EXCEPTION 'Statut mission incompatible avec la création d''un lien de suivi' USING ERRCODE = 'P0001';
  END IF;

  _token := encode(extensions.gen_random_bytes(32), 'base64');
  _hash := encode(extensions.digest(_token, 'sha256'), 'hex');

  INSERT INTO public.mission_tracking_tokens (mission_id, token_hash, created_by)
  VALUES (p_mission_id, _hash, auth.uid());

  RETURN _token;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_tracking_token(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_tracking_token(uuid) TO authenticated;

-- =========================================================
-- 11. RÉVOCATION TOKEN
-- =========================================================

CREATE OR REPLACE FUNCTION public.revoke_tracking_token(p_token_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.is_admin() OR public.is_operator()) THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  UPDATE public.mission_tracking_tokens
  SET revoked_at = now()
  WHERE id = p_token_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Token introuvable' USING ERRCODE = 'P0002';
  END IF;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_tracking_token(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_tracking_token(uuid) TO authenticated;

-- =========================================================
-- 12. GET_PUBLIC_TRACKING MINIMAL
-- =========================================================

CREATE OR REPLACE FUNCTION public.get_public_tracking(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _hash text;
  _token_id uuid;
  _mission_id uuid;
  _mission public.missions%ROWTYPE;
  _last_pos public.mission_gps_positions%ROWTYPE;
  _result jsonb;
BEGIN
  _hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  SELECT id, mission_id INTO _token_id, _mission_id
  FROM public.mission_tracking_tokens
  WHERE token_hash = _hash
    AND (revoked_at IS NULL)
    AND (expires_at > now());

  IF _token_id IS NULL THEN
    RAISE EXCEPTION 'Token invalide, expiré ou révoqué' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO _mission
  FROM public.missions
  WHERE id = _mission_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mission introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF _mission.status IN ('completed', 'archived', 'cancelled') THEN
    RAISE EXCEPTION 'Tracking indisponible pour cette mission' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO _last_pos
  FROM public.mission_gps_positions
  WHERE mission_id = _mission_id
  ORDER BY recorded_at DESC
  LIMIT 1;

  _result := jsonb_build_object(
    'reference', _mission.reference,
    'depart', _mission.depart,
    'arrivee', _mission.arrivee,
    'status', _mission.status,
    'vehicule', _mission.vehicule,
    'position', CASE WHEN _last_pos.id IS NOT NULL THEN
      jsonb_build_object(
        'lat', _last_pos.lat,
        'lng', _last_pos.lng,
        'accuracy', _last_pos.accuracy,
        'speed', _last_pos.speed,
        'recorded_at', _last_pos.recorded_at
      )
    ELSE NULL END,
    'last_updated', COALESCE(_last_pos.recorded_at, _mission.updated_at)
  );

  RETURN _result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_public_tracking(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_tracking(text) TO PUBLIC;

-- =========================================================
-- 13. MATRICE NOTIFICATIONS FINALISÉE
-- =========================================================

CREATE OR REPLACE FUNCTION public.enqueue_mission_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.event_type IN ('mission_assigned', 'edl_departure_validated', 'mission_started', 'edl_arrival_validated', 'mission_delivered', 'mission_cancelled') THEN
    INSERT INTO public.notification_outbox (mission_id, mission_event_id, notification_type, recipient_type, payload, status)
    VALUES (
      NEW.mission_id,
      NEW.id,
      NEW.event_type,
      'client',
      jsonb_build_object(
        'event_type', NEW.event_type,
        'mission_id', NEW.mission_id,
        'metadata', COALESCE(NEW.metadata, '{}'::jsonb)
      ),
      'pending'
    )
    ON CONFLICT (mission_event_id, notification_type, recipient_type) DO NOTHING;

    IF NEW.event_type IN ('mission_assigned', 'mission_cancelled') THEN
      INSERT INTO public.notification_outbox (mission_id, mission_event_id, notification_type, recipient_type, payload, status)
      VALUES (
        NEW.mission_id,
        NEW.id,
        NEW.event_type,
        'convoyeur',
        jsonb_build_object(
          'event_type', NEW.event_type,
          'mission_id', NEW.mission_id,
          'metadata', COALESCE(NEW.metadata, '{}'::jsonb)
        ),
        'pending'
      )
      ON CONFLICT (mission_event_id, notification_type, recipient_type) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mission_events_enqueue_notification ON public.mission_events;
CREATE TRIGGER mission_events_enqueue_notification
  AFTER INSERT ON public.mission_events
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_mission_notification();

COMMIT;
