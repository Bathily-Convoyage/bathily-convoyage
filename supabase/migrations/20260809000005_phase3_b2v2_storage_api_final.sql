-- =====================================================
-- Migration: phase3_b2v2_storage_api_final
-- Objectif : NULL-safe ownership, durcissement storage API
-- =====================================================

BEGIN;

-- =========================================================
-- 1. validate_mission_edl : comparaison owner NULL-safe
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
-- 2. S'ASSURER QUE UPDATE/DELETE PROTECTED REFERENCED OBJECTS
-- =========================================================

DROP POLICY IF EXISTS "convoyeur_media_update_admin_b2v" ON storage.objects;
DROP POLICY IF EXISTS "convoyeur_media_delete_admin_b2v" ON storage.objects;

-- UPDATE : admin seul et non référencé par mission_evidence
CREATE POLICY "convoyeur_media_update_admin_b2v2" ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'convoyeur-media'
    AND public.is_admin()
    AND NOT EXISTS (
      SELECT 1 FROM public.mission_evidence me
      WHERE me.storage_bucket = 'convoyeur-media'
        AND me.storage_path = objects.name
    )
  )
  WITH CHECK (
    bucket_id = 'convoyeur-media'
    AND public.is_admin()
  );

-- DELETE : admin seul et non référencé par mission_evidence
CREATE POLICY "convoyeur_media_delete_admin_b2v2" ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'convoyeur-media'
    AND public.is_admin()
    AND NOT EXISTS (
      SELECT 1 FROM public.mission_evidence me
      WHERE me.storage_bucket = 'convoyeur-media'
        AND me.storage_path = objects.name
    )
  );

-- =========================================================
-- 3. BUCKET MIME TYPES
-- =========================================================

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/png']::text[]
WHERE id = 'convoyeur-media';

COMMIT;
