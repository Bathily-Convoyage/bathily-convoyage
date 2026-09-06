-- =============================================================
-- Migration: missions_ext_4a2_incident_flow_repair
-- Objectif : Réparer le workflow incident pour qu'un convoyeur
--            assigné non-banni puisse signaler, compléter et
--            ajouter des preuves d'incident sans être operator.
--
-- Périmètre :
--   * Redéfinir report_mission_incident (assigned non-banned convoyeur)
--   * Redéfinir update_mission_incident (reporter + assigned + open)
--   * Redéfinir register_mission_incident_evidence (reporter + assigned + open)
--   * RLS : ajouter SELECT convoyeur assigné sur mission_incidents
--   * RLS : ajouter SELECT convoyeur assigné sur mission_incident_evidence
--   * Storage : ajouter INSERT/SELECT convoyeur assigné sur mission-incidents
--   * review_mission_incident (admin) : inchangé
--   * Triggers d'immutabilité : inchangés
--   * log_mission_event : inchangé
--
-- Invariants préservés :
--   * banned = false requis
--   * assignment au convoyeur requise
--   * statuts mission autorisés : accepted, in_progress, delivered
--   * incident status = 'open' pour update/evidence
--   * immutabilité post-resolved
--   * bucket privé mission-incidents
--   * MIME allowlist (jpeg, png, webp)
--   * path structure missions/{mid}/incidents/{iid}/
--   * storage owner = auth.uid()
--   * pas de cross-mission / cross-incident
--   * admin review inchangé
--   * audit log incident_reported / incident_resolved inchangé
--
-- Réutilise : public.is_assigned_non_banned_convoyeur (déployé par 4A1)
-- =============================================================

BEGIN;

-- =============================================================
-- 1. RPC: report_mission_incident (redefined)
-- =============================================================
-- Remplace is_operator() AND is_convoyeur_for_mission() par
-- is_assigned_non_banned_convoyeur(). Préserve tous les autres checks.
-- reported_by = auth.uid() (jamais fourni par le caller).

CREATE OR REPLACE FUNCTION public.report_mission_incident(
  p_mission_id    uuid,
  p_incident_type text,
  p_severity      text,
  p_title         text,
  p_description   text,
  p_occurred_at   timestamptz,
  p_location_text text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _mission        public.missions%ROWTYPE;
  _incident_id    uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- MISSIONS-EXT-4A2: assigned non-banned convoyeur (not operator-only).
  IF NOT public.is_assigned_non_banned_convoyeur(p_mission_id, auth.uid()) THEN
    RAISE EXCEPTION 'Non autorisé ou mission indisponible'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _mission
  FROM public.missions
  WHERE id = p_mission_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé ou mission indisponible'
      USING ERRCODE = '42501';
  END IF;

  -- Statut mission autorisé pour déclarer un incident terrain
  IF _mission.status NOT IN ('accepted', 'in_progress', 'delivered') THEN
    RAISE EXCEPTION 'Non autorisé ou mission indisponible'
      USING ERRCODE = '42501';
  END IF;

  -- Validation des champs
  IF p_incident_type NOT IN (
    'vehicle_breakdown', 'accident', 'damage', 'flat_tire',
    'charging_or_fuel', 'delay', 'documents_or_keys', 'other'
  ) THEN
    RAISE EXCEPTION 'Type d''incident invalide : %', p_incident_type
      USING ERRCODE = '23514';
  END IF;

  IF p_severity NOT IN ('low', 'medium', 'high', 'critical') THEN
    RAISE EXCEPTION 'Sévérité invalide : %', p_severity
      USING ERRCODE = '23514';
  END IF;

  IF p_title IS NULL OR length(btrim(p_title)) = 0 OR length(p_title) > 120 THEN
    RAISE EXCEPTION 'Titre invalide (vide ou > 120 caractères)'
      USING ERRCODE = '23514';
  END IF;

  IF p_description IS NULL OR length(btrim(p_description)) = 0
     OR length(p_description) > 2000 THEN
    RAISE EXCEPTION 'Description invalide (vide ou > 2000 caractères)'
      USING ERRCODE = '23514';
  END IF;

  IF p_location_text IS NOT NULL AND length(p_location_text) > 300 THEN
    RAISE EXCEPTION 'Localisation trop longue (> 300 caractères)'
      USING ERRCODE = '23514';
  END IF;

  IF p_occurred_at IS NULL THEN
    RAISE EXCEPTION 'Date d''occurrence requise'
      USING ERRCODE = '23514';
  END IF;

  -- Insertion (reported_by = auth.uid())
  INSERT INTO public.mission_incidents (
    mission_id,
    reported_by,
    incident_type,
    severity,
    title,
    description,
    occurred_at,
    location_text,
    status
  ) VALUES (
    p_mission_id,
    auth.uid(),
    p_incident_type,
    p_severity,
    p_title,
    p_description,
    p_occurred_at,
    p_location_text,
    'open'
  )
  RETURNING id INTO _incident_id;

  -- Journalisation
  PERFORM public.log_mission_event(
    p_mission_id,
    'incident_reported',
    NULL,
    NULL,
    'convoyeur',
    jsonb_build_object(
      'incident_id', _incident_id,
      'incident_type', p_incident_type,
      'severity', p_severity
    )
  );

  RETURN _incident_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_mission_incident(uuid, text, text, text, text, timestamptz, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.report_mission_incident(uuid, text, text, text, text, timestamptz, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.report_mission_incident(uuid, text, text, text, text, timestamptz, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.report_mission_incident(uuid, text, text, text, text, timestamptz, text) TO authenticated;

-- =============================================================
-- 2. RPC: update_mission_incident (redefined)
-- =============================================================
-- Reporter = auth.uid() AND assigned non-banned convoyeur AND status = 'open'.
-- Champs modifiables : incident_type, severity, title, description, location_text.
-- Champs figés : id, mission_id, reported_by, occurred_at, status, created_at,
--                reviewed_*, resolved_*.

CREATE OR REPLACE FUNCTION public.update_mission_incident(
  p_incident_id    uuid,
  p_incident_type  text DEFAULT NULL,
  p_severity       text DEFAULT NULL,
  p_title          text DEFAULT NULL,
  p_description    text DEFAULT NULL,
  p_location_text  text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _incident  public.mission_incidents%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _incident
  FROM public.mission_incidents
  WHERE id = p_incident_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé ou incident indisponible'
      USING ERRCODE = '42501';
  END IF;

  -- MISSIONS-EXT-4A2: reporter + assigned non-banned convoyeur.
  IF _incident.reported_by <> auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé ou incident indisponible'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_assigned_non_banned_convoyeur(_incident.mission_id, auth.uid()) THEN
    RAISE EXCEPTION 'Non autorisé ou incident indisponible'
      USING ERRCODE = '42501';
  END IF;

  -- Seul un incident open peut être complété
  IF _incident.status <> 'open' THEN
    RAISE EXCEPTION 'Incident non modifiable (statut : %)', _incident.status
      USING ERRCODE = '42501';
  END IF;

  -- Validation des champs fournis (non-NULL)
  IF p_incident_type IS NOT NULL AND p_incident_type NOT IN (
    'vehicle_breakdown', 'accident', 'damage', 'flat_tire',
    'charging_or_fuel', 'delay', 'documents_or_keys', 'other'
  ) THEN
    RAISE EXCEPTION 'Type d''incident invalide : %', p_incident_type
      USING ERRCODE = '23514';
  END IF;

  IF p_severity IS NOT NULL AND p_severity NOT IN ('low', 'medium', 'high', 'critical') THEN
    RAISE EXCEPTION 'Sévérité invalide : %', p_severity
      USING ERRCODE = '23514';
  END IF;

  IF p_title IS NOT NULL AND (length(btrim(p_title)) = 0 OR length(p_title) > 120) THEN
    RAISE EXCEPTION 'Titre invalide (vide ou > 120 caractères)'
      USING ERRCODE = '23514';
  END IF;

  IF p_description IS NOT NULL
     AND (length(btrim(p_description)) = 0 OR length(p_description) > 2000) THEN
    RAISE EXCEPTION 'Description invalide (vide ou > 2000 caractères)'
      USING ERRCODE = '23514';
  END IF;

  IF p_location_text IS NOT NULL AND length(p_location_text) > 300 THEN
    RAISE EXCEPTION 'Localisation trop longue (> 300 caractères)'
      USING ERRCODE = '23514';
  END IF;

  -- Update (COALESCE : ne remplace que les champs fournis)
  UPDATE public.mission_incidents
  SET
    incident_type = COALESCE(p_incident_type, incident_type),
    severity      = COALESCE(p_severity, severity),
    title         = COALESCE(p_title, title),
    description   = COALESCE(p_description, description),
    location_text = COALESCE(p_location_text, location_text)
  WHERE id = p_incident_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_mission_incident(uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_mission_incident(uuid, text, text, text, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_mission_incident(uuid, text, text, text, text, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.update_mission_incident(uuid, text, text, text, text, text) TO authenticated;

-- =============================================================
-- 3. RPC: register_mission_incident_evidence (redefined)
-- =============================================================
-- Reporter = auth.uid() AND assigned non-banned convoyeur AND incident open.
-- Vérifie : bucket, MIME, path cohérent, objet Storage existant + owner.

CREATE OR REPLACE FUNCTION public.register_mission_incident_evidence(
  p_incident_id    uuid,
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
  _incident   public.mission_incidents%ROWTYPE;
  _obj        record;
  _evidence_id uuid;
  _expected_path_prefix text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé' USING ERRCODE = '42501';
  END IF;

  -- Bucket imposé
  IF p_storage_bucket IS NULL OR p_storage_bucket <> 'mission-incidents' THEN
    RAISE EXCEPTION 'Bucket invalide pour les preuves d''incident'
      USING ERRCODE = 'P0001';
  END IF;

  -- MIME autorisé
  IF p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'Type MIME non autorisé : %', p_mime_type
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO _incident
  FROM public.mission_incidents
  WHERE id = p_incident_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé ou incident indisponible'
      USING ERRCODE = '42501';
  END IF;

  -- MISSIONS-EXT-4A2: reporter + assigned non-banned convoyeur.
  IF _incident.reported_by <> auth.uid() THEN
    RAISE EXCEPTION 'Non autorisé ou incident indisponible'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_assigned_non_banned_convoyeur(_incident.mission_id, auth.uid()) THEN
    RAISE EXCEPTION 'Non autorisé ou incident indisponible'
      USING ERRCODE = '42501';
  END IF;

  -- Incident doit être open pour ajouter une preuve
  IF _incident.status <> 'open' THEN
    RAISE EXCEPTION 'Incident non modifiable (statut : %)', _incident.status
      USING ERRCODE = '42501';
  END IF;

  -- Vérifier la cohérence du path : missions/{mission_id}/incidents/{incident_id}/
  _expected_path_prefix := 'missions/' || _incident.mission_id::text
                           || '/incidents/' || _incident.id::text || '/';

  IF position(_expected_path_prefix in p_storage_path) <> 1 THEN
    RAISE EXCEPTION 'Chemin de preuve incohérent avec la mission/incident'
      USING ERRCODE = 'P0001';
  END IF;

  -- Vérifier que l'objet Storage existe et appartient au caller
  SELECT id, owner INTO _obj
  FROM storage.objects
  WHERE bucket_id = p_storage_bucket
    AND name = p_storage_path;

  IF _obj.id IS NULL THEN
    RAISE EXCEPTION 'Objet Storage introuvable : %/%', p_storage_bucket, p_storage_path
      USING ERRCODE = 'P0002';
  END IF;

  IF _obj.owner IS NULL OR _obj.owner IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'La preuve n''appartient pas à l''utilisateur appelant'
      USING ERRCODE = '42501';
  END IF;

  -- Insertion (created_by = auth.uid())
  INSERT INTO public.mission_incident_evidence (
    incident_id,
    storage_bucket,
    storage_path,
    mime_type,
    created_by
  ) VALUES (
    p_incident_id,
    p_storage_bucket,
    p_storage_path,
    p_mime_type,
    auth.uid()
  )
  RETURNING id INTO _evidence_id;

  RETURN _evidence_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_mission_incident_evidence(uuid, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.register_mission_incident_evidence(uuid, text, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.register_mission_incident_evidence(uuid, text, text, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.register_mission_incident_evidence(uuid, text, text, text) TO authenticated;

-- =============================================================
-- 4. RLS: mission_incidents — add convoyeur SELECT
-- =============================================================
-- L'ancienne policy operator-only reste (pour les operators internes
-- qui sont aussi assignés). On ajoute une policy convoyeur-only
-- qui ne requiert pas is_operator().

DROP POLICY IF EXISTS "mission_incidents_select_convoyeur_assigned"
  ON public.mission_incidents;

CREATE POLICY "mission_incidents_select_convoyeur_assigned"
  ON public.mission_incidents
  FOR SELECT
  TO authenticated
  USING (
    reported_by = auth.uid()
    AND public.is_assigned_non_banned_convoyeur(mission_incidents.mission_id, auth.uid())
  );

-- =============================================================
-- 5. RLS: mission_incident_evidence — add convoyeur SELECT
-- =============================================================

DROP POLICY IF EXISTS "mission_incident_evidence_select_convoyeur_assigned"
  ON public.mission_incident_evidence;

CREATE POLICY "mission_incident_evidence_select_convoyeur_assigned"
  ON public.mission_incident_evidence
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.mission_incidents mi
      WHERE mi.id = mission_incident_evidence.incident_id
        AND mi.reported_by = auth.uid()
        AND public.is_assigned_non_banned_convoyeur(mi.mission_id, auth.uid())
    )
  );

-- =============================================================
-- 6. STORAGE RLS: mission-incidents — add convoyeur INSERT
-- =============================================================
-- Path : missions/{mission_id}/incidents/{incident_id}/{filename}
-- Convoyeur assigné non-banni + incident open + path cohérent.

DROP POLICY IF EXISTS "mission_incidents_storage_insert_convoyeur"
  ON storage.objects;

CREATE POLICY "mission_incidents_storage_insert_convoyeur"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'mission-incidents'
    AND name ~ '^missions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/incidents/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
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
      FROM public.mission_incidents mi
      WHERE (mi.id)::text = split_part(objects.name, '/', 4)
        AND (mi.mission_id)::text = split_part(objects.name, '/', 2)
        AND mi.reported_by = auth.uid()
        AND mi.status = 'open'
    )
  );

-- =============================================================
-- 7. STORAGE RLS: mission-incidents — add convoyeur SELECT
-- =============================================================

DROP POLICY IF EXISTS "mission_incidents_storage_select_convoyeur"
  ON storage.objects;

CREATE POLICY "mission_incidents_storage_select_convoyeur"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'mission-incidents'
    AND EXISTS (
      SELECT 1
      FROM public.mission_incidents mi
      JOIN public.missions m ON m.id = mi.mission_id
      JOIN public.convoyeurs cv ON cv.id = m.convoyeur_id
      WHERE (mi.id)::text = split_part(objects.name, '/', 4)
        AND (mi.mission_id)::text = split_part(objects.name, '/', 2)
        AND mi.reported_by = auth.uid()
        AND cv.auth_user_id = auth.uid()
        AND cv.banned = false
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
