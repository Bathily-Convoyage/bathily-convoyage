-- =====================================================
-- Migration: phase3_c22c1_mission_incidents
-- Objectif : Backend V1 des incidents de mission
--
-- Périmètre :
--   * Table mission_incidents
--   * Table mission_incident_evidence
--   * Bucket privé mission-incidents
--   * RLS (SELECT uniquement côté applicatif)
--   * RPC SECURITY DEFINER pour toutes les écritures métier
--   * Triggers défense en profondeur
--   * Journalisation via log_mission_event
--
-- Invariant : external_convoyeurs_enabled = false
-- Accès externe : AUCUN (opérateurs internes uniquement)
--
-- Architecture :
--   - RLS  = SELECT autorisé + blocage INSERT/UPDATE/DELETE directs
--   - RPC  = chemin unique d'écriture métier (SECURITY DEFINER)
--   - Trigger = défense en profondeur (champs protégés, immutabilité preuves)
-- =====================================================

BEGIN;

-- =========================================================
-- 0. BUCKET STORAGE mission-incidents (privé)
-- =========================================================
-- Path interne : missions/{mission_id}/incidents/{incident_id}/{filename}
-- (cohérent avec le pattern convoyeur-media : missions/{uuid}/...)
-- Formats : JPEG, PNG, WebP. Pas de PDF.
-- Limite : 5 MiB (5242880 octets).

INSERT INTO storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
VALUES (
  'mission-incidents',
  'mission-incidents',
  false,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[],
  5242880
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  allowed_mime_types = EXCLUDED.allowed_mime_types,
  file_size_limit = EXCLUDED.file_size_limit;

-- =========================================================
-- 1. TABLE mission_incidents
-- =========================================================
-- FK mission_id ON DELETE RESTRICT : un incident déclaré empêche la
-- suppression de la mission. Objectif métier : auditabilité — un
-- incident ne peut pas disparaître indirectement via CASCADE.
-- (PostgreSQL : RESTRICT est la stratégie par défaut ; explicite ici
--  pour lisibilité et intentionnalité.)

CREATE TABLE IF NOT EXISTS public.mission_incidents (
  id               uuid        DEFAULT gen_random_uuid() NOT NULL,
  mission_id       uuid        NOT NULL REFERENCES public.missions(id) ON DELETE RESTRICT,
  reported_by      uuid        NOT NULL,
  incident_type    text        NOT NULL,
  severity         text        NOT NULL DEFAULT 'medium',
  title            text        NOT NULL,
  description      text        NOT NULL,
  occurred_at      timestamptz NOT NULL,
  location_text    text,
  status           text        NOT NULL DEFAULT 'open',
  created_at       timestamptz NOT NULL DEFAULT now(),
  reviewed_at      timestamptz,
  reviewed_by      uuid,
  resolved_at      timestamptz,
  resolved_by      uuid,
  resolution_notes text,
  PRIMARY KEY (id),
  CONSTRAINT mission_incidents_incident_type_check CHECK (incident_type IN (
    'vehicle_breakdown',
    'accident',
    'damage',
    'flat_tire',
    'charging_or_fuel',
    'delay',
    'documents_or_keys',
    'other'
  )),
  CONSTRAINT mission_incidents_severity_check CHECK (severity IN (
    'low', 'medium', 'high', 'critical'
  )),
  CONSTRAINT mission_incidents_status_check CHECK (status IN (
    'open', 'reviewed', 'resolved'
  )),
  CONSTRAINT mission_incidents_title_check CHECK (
    length(btrim(title)) > 0 AND length(title) <= 120
  ),
  CONSTRAINT mission_incidents_description_check CHECK (
    length(btrim(description)) > 0 AND length(description) <= 2000
  ),
  CONSTRAINT mission_incidents_location_check CHECK (
    location_text IS NULL OR length(location_text) <= 300
  ),
  CONSTRAINT mission_incidents_resolution_notes_check CHECK (
    resolution_notes IS NULL OR length(resolution_notes) <= 2000
  )
);

ALTER TABLE public.mission_incidents OWNER TO "postgres";

-- =========================================================
-- 2. INDEXES mission_incidents
-- =========================================================
-- (mission_id) : filtre par mission (operator cockpit, admin modal)
-- (status) : filtre admin "incidents ouverts à examiner"
-- (mission_id, status) : combinaison la plus fréquente (operator regarde
--   ses incidents ouverts sur une mission donnée). Index composite couvre
--   aussi le filtre mission_id seul (prefixe gauche).

CREATE INDEX IF NOT EXISTS mission_incidents_mission_idx
  ON public.mission_incidents(mission_id);
CREATE INDEX IF NOT EXISTS mission_incidents_status_idx
  ON public.mission_incidents(status);
CREATE INDEX IF NOT EXISTS mission_incidents_mission_status_idx
  ON public.mission_incidents(mission_id, status);

-- =========================================================
-- 3. TABLE mission_incident_evidence
-- =========================================================
-- FK incident_id ON DELETE RESTRICT : cohérent avec l'immutabilité.
-- L'incident n'étant jamais supprimé, l'evidence ne l'est pas non plus.
-- Si une suppression future est envisagée, elle devra passer par un
-- workflow dédié (service_role + API Storage), pas par CASCADE.

CREATE TABLE IF NOT EXISTS public.mission_incident_evidence (
  id             uuid        DEFAULT gen_random_uuid() NOT NULL,
  incident_id    uuid        NOT NULL REFERENCES public.mission_incidents(id) ON DELETE RESTRICT,
  storage_bucket text        NOT NULL,
  storage_path   text        NOT NULL,
  mime_type      text,
  created_by     uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  metadata       jsonb       DEFAULT '{}'::jsonb,
  PRIMARY KEY (id),
  CONSTRAINT mission_incident_evidence_bucket_check CHECK (
    storage_bucket = 'mission-incidents'
  )
);

ALTER TABLE public.mission_incident_evidence OWNER TO "postgres";

CREATE INDEX IF NOT EXISTS mission_incident_evidence_incident_idx
  ON public.mission_incident_evidence(incident_id);

-- =========================================================
-- 4. TRIGGER — défense en profondeur mission_incidents
-- =========================================================
-- Permet les UPDATE/DELETE par les RPC SECURITY DEFINER (current_user =
-- 'postgres'). Bloque tout UPDATE/DELETE direct applicatif.
-- Pour les UPDATE autorisés via RPC, vérifie que les champs protégés
-- ne sont pas modifiés (double sécurité au-delà de la RPC).

CREATE OR REPLACE FUNCTION public.mission_incidents_protect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- Les RPC métier SECURITY DEFINER s'exécutent en tant que postgres.
  IF current_user = 'postgres' THEN
    IF TG_OP = 'DELETE' THEN
      -- Même les RPC ne suppriment jamais un incident.
      RAISE EXCEPTION 'mission_incidents : suppression interdite (auditabilité)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Toute opération directe non-RPC est interdite.
  RAISE EXCEPTION 'mission_incidents : opération % interdite hors RPC métier', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS mission_incidents_protect_trigger ON public.mission_incidents;
CREATE TRIGGER mission_incidents_protect_trigger
  BEFORE UPDATE OR DELETE ON public.mission_incidents
  FOR EACH ROW
  EXECUTE FUNCTION public.mission_incidents_protect();

-- =========================================================
-- 5. TRIGGER — immutabilité mission_incident_evidence
-- =========================================================
-- Pattern identique à mission_evidence_immutable (20260809000003).
-- UPDATE et DELETE bloqués inconditionnellement (y compris postgres).
-- L'INSERT se fait via register_mission_incident_evidence (SECURITY DEFINER).

CREATE OR REPLACE FUNCTION public.mission_incident_evidence_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'mission_incident_evidence est strictement immutable : % interdit', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS mission_incident_evidence_immutable_trigger ON public.mission_incident_evidence;
CREATE TRIGGER mission_incident_evidence_immutable_trigger
  BEFORE UPDATE OR DELETE ON public.mission_incident_evidence
  FOR EACH ROW
  EXECUTE FUNCTION public.mission_incident_evidence_immutable();

-- =========================================================
-- 6. RLS — mission_incidents
-- =========================================================
-- SELECT uniquement côté applicatif. INSERT/UPDATE/DELETE via RPC.

ALTER TABLE public.mission_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mission_incidents FORCE ROW LEVEL SECURITY;

-- Admin : SELECT tous
CREATE POLICY "mission_incidents_select_admin"
  ON public.mission_incidents
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Operator interne assigné : SELECT ses incidents uniquement
-- Gate : is_operator() AND mission assignée au convoyeur de l'utilisateur.
-- On inline la vérification (comme mission_events_convoyeur_select_b2)
-- car is_convoyeur_for_mission() est SECURITY INVOKER et peut échouer
-- dans le contexte RLS (nested RLS sur missions/convoyeurs).
-- PAS de gate external_convoyeurs_enabled : C-2.2C1 est interne uniquement.
CREATE POLICY "mission_incidents_select_operator_assigned"
  ON public.mission_incidents
  FOR SELECT
  TO authenticated
  USING (
    public.is_operator()
    AND EXISTS (
      SELECT 1 FROM public.missions m
      WHERE m.id = mission_incidents.mission_id
        AND m.convoyeur_id IN (
          SELECT c.id FROM public.convoyeurs c
          WHERE c.auth_user_id = auth.uid()
        )
    )
  );

-- Aucune policy INSERT/UPDATE/DELETE : blocage direct.
-- Les RPC SECURITY DEFINER contournent la RLS (rôles postgres/service_role).

REVOKE ALL ON public.mission_incidents FROM PUBLIC;
REVOKE ALL ON public.mission_incidents FROM anon;
REVOKE ALL ON public.mission_incidents FROM authenticated;
GRANT SELECT ON public.mission_incidents TO authenticated;
GRANT ALL ON public.mission_incidents TO postgres;

-- =========================================================
-- 7. RLS — mission_incident_evidence
-- =========================================================

ALTER TABLE public.mission_incident_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mission_incident_evidence FORCE ROW LEVEL SECURITY;

-- Admin : SELECT tous
CREATE POLICY "mission_incident_evidence_select_admin"
  ON public.mission_incident_evidence
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Operator interne assigné : SELECT preuves de ses incidents
-- (lecture autorisée même après resolved — pas de filtre status)
-- On inline la vérification (même raison que mission_incidents RLS).
CREATE POLICY "mission_incident_evidence_select_operator_assigned"
  ON public.mission_incident_evidence
  FOR SELECT
  TO authenticated
  USING (
    public.is_operator()
    AND EXISTS (
      SELECT 1 FROM public.mission_incidents mi
      JOIN public.missions m ON m.id = mi.mission_id
      WHERE mi.id = mission_incident_evidence.incident_id
        AND m.convoyeur_id IN (
          SELECT c.id FROM public.convoyeurs c
          WHERE c.auth_user_id = auth.uid()
        )
    )
  );

REVOKE ALL ON public.mission_incident_evidence FROM PUBLIC;
REVOKE ALL ON public.mission_incident_evidence FROM anon;
REVOKE ALL ON public.mission_incident_evidence FROM authenticated;
GRANT SELECT ON public.mission_incident_evidence TO authenticated;
GRANT ALL ON public.mission_incident_evidence TO postgres;

-- =========================================================
-- 8. STORAGE RLS — bucket mission-incidents
-- =========================================================
-- Path : missions/{mission_id}/incidents/{incident_id}/{filename}
-- INSERT : operator interne assigné + incident open + path cohérent.
-- SELECT : admin OU operator interne assigné à la mission du path.
-- UPDATE/DELETE : aucun (preuves immuables).

-- INSERT
DROP POLICY IF EXISTS "mission_incidents_storage_insert" ON storage.objects;
CREATE POLICY "mission_incidents_storage_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'mission-incidents'
    AND name ~ '^missions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/incidents/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
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
      FROM public.mission_incidents mi
      WHERE (mi.id)::text = split_part(objects.name, '/', 4)
        AND (mi.mission_id)::text = split_part(objects.name, '/', 2)
        AND mi.status = 'open'
    )
  );

-- SELECT (lecture via API authentifiée / signed URLs)
DROP POLICY IF EXISTS "mission_incidents_storage_select" ON storage.objects;
CREATE POLICY "mission_incidents_storage_select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'mission-incidents'
    AND (
      public.is_admin()
      OR (
        public.is_operator()
        AND EXISTS (
          SELECT 1
          FROM public.missions m
          JOIN public.convoyeurs cv ON cv.id = m.convoyeur_id
          WHERE (m.id)::text = split_part(objects.name, '/', 2)
            AND cv.auth_user_id = auth.uid()
        )
      )
    )
  );

-- Aucune policy UPDATE/DELETE : preuves immuables au niveau Storage.

-- =========================================================
-- 9. RPC — report_mission_incident
-- =========================================================
-- Déclare un incident par un operator interne assigné à la mission.
-- Anti-énumération : mission inexistante / non assignée / non autorisée
-- → même message générique.
-- Statuts mission autorisés : accepted, in_progress, delivered.

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
  _authorized     boolean;
  _incident_id    uuid;
BEGIN
  -- Autorisation : operator interne ET assigné à cette mission.
  -- Anti-énumération : même erreur pour mission inexistante / non assignée.
  SELECT
    (public.is_operator()
     AND public.is_convoyeur_for_mission(p_mission_id, auth.uid()))
  INTO _authorized;

  IF COALESCE(_authorized, false) = false THEN
    RAISE EXCEPTION 'Non autorisé ou mission indisponible'
      USING ERRCODE = '42501';
  END IF;

  -- Récupérer la mission (sûre d'exister si is_convoyeur_for_mission = true)
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

  -- Validation des champs (les CHECK de table valideront aussi, mais on
  -- veut des erreurs explicites avant l'INSERT)
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

  -- Insertion (reported_by = auth.uid(), jamais fourni par le caller)
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

  -- Journalisation : metadata sans PII (pas de description/location)
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
GRANT EXECUTE ON FUNCTION public.report_mission_incident(uuid, text, text, text, text, timestamptz, text) TO authenticated;

-- =========================================================
-- 10. RPC — update_mission_incident
-- =========================================================
-- Complète un incident tant que status = 'open'.
-- Champs modifiables : incident_type, severity, title, description, location_text.
-- Champs figés : id, mission_id, reported_by, occurred_at, status, created_at,
--                reviewed_*, resolved_*.
-- Autorisation : operator interne assigné à la mission de l'incident.

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
  _authorized boolean;
BEGIN
  SELECT * INTO _incident
  FROM public.mission_incidents
  WHERE id = p_incident_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Non autorisé ou incident indisponible'
      USING ERRCODE = '42501';
  END IF;

  -- Autorisation : operator interne assigné à la mission de l'incident
  SELECT
    (public.is_operator()
     AND public.is_convoyeur_for_mission(_incident.mission_id, auth.uid()))
  INTO _authorized;

  IF COALESCE(_authorized, false) = false THEN
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
GRANT EXECUTE ON FUNCTION public.update_mission_incident(uuid, text, text, text, text, text) TO authenticated;

-- =========================================================
-- 11. RPC — review_mission_incident (admin)
-- =========================================================
-- Transitions : open → reviewed, open → resolved, reviewed → resolved.
-- resolved est terminal (pas de réouverture V1).
-- Admin uniquement (is_admin()).

CREATE OR REPLACE FUNCTION public.review_mission_incident(
  p_incident_id      uuid,
  p_target_status    text,
  p_resolution_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _incident public.mission_incidents%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Non autorisé'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _incident
  FROM public.mission_incidents
  WHERE id = p_incident_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incident introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  -- Validation transition
  IF NOT (
    (_incident.status = 'open' AND p_target_status IN ('reviewed', 'resolved'))
    OR (_incident.status = 'reviewed' AND p_target_status = 'resolved')
  ) THEN
    RAISE EXCEPTION 'Transition interdite : % -> %', _incident.status, p_target_status
      USING ERRCODE = 'P0001';
  END IF;

  -- resolved : resolution_notes non vide requis
  IF p_target_status = 'resolved' THEN
    IF p_resolution_notes IS NULL OR length(btrim(p_resolution_notes)) = 0 THEN
      RAISE EXCEPTION 'resolution_notes est requis pour résoudre un incident'
        USING ERRCODE = 'P0001';
    END IF;
    IF length(p_resolution_notes) > 2000 THEN
      RAISE EXCEPTION 'resolution_notes trop long (> 2000 caractères)'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Application de la transition
  IF p_target_status = 'reviewed' THEN
    UPDATE public.mission_incidents
    SET status = 'reviewed',
        reviewed_at = now(),
        reviewed_by = auth.uid()
    WHERE id = p_incident_id;
  ELSIF p_target_status = 'resolved' THEN
    UPDATE public.mission_incidents
    SET status = 'resolved',
        resolved_at = now(),
        resolved_by = auth.uid(),
        resolution_notes = p_resolution_notes
    WHERE id = p_incident_id;

    -- Journalisation résolution : metadata minimale (incident_id seulement)
    PERFORM public.log_mission_event(
      _incident.mission_id,
      'incident_resolved',
      NULL,
      NULL,
      'admin',
      jsonb_build_object('incident_id', p_incident_id)
    );
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.review_mission_incident(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.review_mission_incident(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.review_mission_incident(uuid, text, text) TO authenticated;

-- =========================================================
-- 12. RPC — register_mission_incident_evidence
-- =========================================================
-- Enregistre une preuve après upload Storage réussi.
-- Vérifie : operator interne assigné, incident open, path cohérent
-- avec mission_id + incident_id, MIME autorisé, objet Storage existant
-- et propriétaire = auth.uid().
-- created_by = auth.uid() (jamais fourni par le caller).

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
  _authorized boolean;
  _obj        record;
  _evidence_id uuid;
  _expected_path_prefix text;
BEGIN
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

  -- Autorisation : operator interne assigné à la mission de l'incident
  SELECT
    (public.is_operator()
     AND public.is_convoyeur_for_mission(_incident.mission_id, auth.uid()))
  INTO _authorized;

  IF COALESCE(_authorized, false) = false THEN
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
GRANT EXECUTE ON FUNCTION public.register_mission_incident_evidence(uuid, text, text, text) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
