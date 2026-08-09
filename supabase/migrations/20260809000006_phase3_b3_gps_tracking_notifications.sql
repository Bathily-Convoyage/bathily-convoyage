-- =====================================================
-- Migration: phase3_b3_gps_tracking_notifications
-- Objectif : sécuriser GPS, tracking public, notifications
-- =====================================================

BEGIN;

-- =========================================================
-- 1. SUPPRIMER L'ACCÈS ANON PUBLIC À missions
-- =========================================================

DROP POLICY IF EXISTS "missions_select_tracking_anon" ON public.missions;

DROP POLICY IF EXISTS "missions_select_own_or_admin_b1" ON public.missions;

CREATE POLICY "missions_select_b3" ON public.missions
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin()
    OR public.is_operator()
    OR client_id IN (SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid())
    OR client_email = (auth.jwt() ->> 'email')
    OR convoyeur_id IN (SELECT c.id FROM public.convoyeurs c WHERE c.auth_user_id = auth.uid())
    OR status = 'available'
  );

-- =========================================================
-- 2. TABLE : mission_tracking_tokens
-- =========================================================

CREATE TABLE IF NOT EXISTS public.mission_tracking_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id    uuid NOT NULL REFERENCES public.missions(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  revoked_at    timestamptz,
  created_by    uuid,
  metadata      jsonb DEFAULT '{}'::jsonb
);

COMMENT ON TABLE public.mission_tracking_tokens IS 'Tokens de suivi public à usage unique par mission.';

-- RLS : seuls client/convoyeur/admin de la mission peuvent lister/créer
ALTER TABLE public.mission_tracking_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tracking_tokens_select_b3" ON public.mission_tracking_tokens;
CREATE POLICY "tracking_tokens_select_b3" ON public.mission_tracking_tokens
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = mission_tracking_tokens.mission_id
        AND (
          public.is_admin()
          OR m.client_id IN (SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid())
          OR m.convoyeur_id IN (SELECT c.id FROM public.convoyeurs c WHERE c.auth_user_id = auth.uid())
        )
    )
  );

DROP POLICY IF EXISTS "tracking_tokens_insert_b3" ON public.mission_tracking_tokens;
CREATE POLICY "tracking_tokens_insert_b3" ON public.mission_tracking_tokens
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = mission_tracking_tokens.mission_id
        AND (
          public.is_admin()
          OR m.client_id IN (SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid())
          OR m.convoyeur_id IN (SELECT c.id FROM public.convoyeurs c WHERE c.auth_user_id = auth.uid())
        )
    )
  );

-- =========================================================
-- 3. TABLE : mission_gps_positions
-- =========================================================

CREATE TABLE IF NOT EXISTS public.mission_gps_positions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id    uuid NOT NULL REFERENCES public.missions(id) ON DELETE CASCADE,
  lat           double precision NOT NULL,
  lng           double precision NOT NULL,
  accuracy      double precision,
  speed         double precision,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  metadata      jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_gps_positions_mission_recorded
  ON public.mission_gps_positions (mission_id, recorded_at DESC);

COMMENT ON TABLE public.mission_gps_positions IS 'Positions GPS historiques des missions.';

ALTER TABLE public.mission_gps_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gps_positions_select_b3" ON public.mission_gps_positions;
CREATE POLICY "gps_positions_select_b3" ON public.mission_gps_positions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = mission_gps_positions.mission_id
        AND (
          public.is_admin()
          OR m.client_id IN (SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid())
          OR m.convoyeur_id IN (SELECT c.id FROM public.convoyeurs c WHERE c.auth_user_id = auth.uid())
        )
    )
  );

DROP POLICY IF EXISTS "gps_positions_insert_b3" ON public.mission_gps_positions;
CREATE POLICY "gps_positions_insert_b3" ON public.mission_gps_positions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = mission_gps_positions.mission_id
        AND m.status = 'in_progress'
        AND m.convoyeur_id IN (SELECT c.id FROM public.convoyeurs c WHERE c.auth_user_id = auth.uid())
    )
  );

-- =========================================================
-- 4. TABLE : notification_outbox
-- =========================================================

CREATE TABLE IF NOT EXISTS public.notification_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id          uuid REFERENCES public.missions(id) ON DELETE CASCADE,
  mission_event_id    uuid REFERENCES public.mission_events(id) ON DELETE CASCADE,
  notification_type   text NOT NULL,
  recipient_type      text NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'pending',
  attempts            int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  last_error          text
);

COMMENT ON TABLE public.notification_outbox IS 'Queue de notifications asynchrones, non bloquante pour le workflow.';

-- =========================================================
-- 5. FONCTIONS GPS
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

REVOKE EXECUTE ON FUNCTION public.authorize_gps_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorize_gps_session(uuid) TO authenticated;

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

CREATE OR REPLACE FUNCTION public.create_tracking_token(p_mission_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _token text;
  _hash text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.missions m
    WHERE m.id = p_mission_id
      AND (
        public.is_admin()
        OR m.client_id IN (SELECT c.id FROM public.clients c WHERE c.auth_user_id = auth.uid())
        OR m.convoyeur_id IN (SELECT c.id FROM public.convoyeurs c WHERE c.auth_user_id = auth.uid())
      )
  ) THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
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

  -- Missions terminées : pas de suivi live
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
    'convoyeur_nom', _mission.convoyeur_nom,
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
-- 6. NOTIFICATIONS — outbox depuis mission_events
-- =========================================================

CREATE OR REPLACE FUNCTION public.enqueue_mission_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Matrice événement -> notification
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
    );

    IF NEW.event_type IN ('mission_assigned') THEN
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
      );
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
