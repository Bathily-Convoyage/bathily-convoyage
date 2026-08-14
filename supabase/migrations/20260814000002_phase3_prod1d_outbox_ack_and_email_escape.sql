-- =========================================================
-- PROD-1D-A.2R — OUTBOX ACK HARDENING + HTML ESCAPE
--
-- Objectifs :
--   1. Préserver toute la logique de 20260814000001
--   2. Ajouter l'échappement HTML de mission.reference (defense in depth)
--   3. Conserver service_role ONLY
--   4. Conserver SECURITY DEFINER, search_path = ''
--
-- Ne modifie aucune table, aucun trigger, aucun feature flag.
-- =========================================================

-- =========================================================
-- REMPLACEMENT DU RPC process_notification_outbox
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
  _safe_reference text;
BEGIN
  -- Validation du paramètre p_limit
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'p_limit doit être compris entre 1 et 100'
      USING ERRCODE = '22023';
  END IF;

  FOR _row IN
    SELECT no.*
    FROM public.notification_outbox no
    WHERE no.status = 'pending'
       OR no.status = 'retry'
       OR (no.status = 'prepared' AND no.prepared_at <= now() - interval '10 minutes')
    ORDER BY no.created_at
    FOR UPDATE OF no SKIP LOCKED
    LIMIT p_limit
  LOOP
    BEGIN
      -- -----------------------------------------------------
      -- CAS 1 : pending — première préparation
      -- -----------------------------------------------------
      IF _row.status = 'pending' THEN
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
          -- Destinataire introuvable : échec terminal, aucun appel provider
          UPDATE public.notification_outbox AS no
          SET status = 'failed', prepared_at = NULL, sent_at = NULL,
              last_error = 'Destinataire introuvable'
          WHERE no.id = _row.id;
          RETURN QUERY SELECT _row.id, 'failed', _row.attempts, 'Destinataire introuvable'::text;
          CONTINUE;
        END IF;

        -- Construction du sujet
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

        -- Échappement HTML de mission.reference (defense in depth)
        -- Ordre important : & en premier
        _safe_reference := COALESCE(_mission.reference, 'inconnue');
        _safe_reference := replace(_safe_reference, '&', '&amp;');
        _safe_reference := replace(_safe_reference, '<', '&lt;');
        _safe_reference := replace(_safe_reference, '>', '&gt;');
        _safe_reference := replace(_safe_reference, '"', '&quot;');
        _safe_reference := replace(_safe_reference, '''', '&#39;');

        -- Construction du corps avec référence échappée
        _body := CASE _row.notification_type
          WHEN 'mission_assigned' THEN '<p>Votre mission ' || _safe_reference || ' a été assignée.</p>'
          WHEN 'edl_departure_validated' THEN '<p>Le départ de la mission ' || _safe_reference || ' est confirmé.</p>'
          WHEN 'mission_started' THEN '<p>La mission ' || _safe_reference || ' est en cours.</p>'
          WHEN 'edl_arrival_validated' THEN '<p>L''arrivée de la mission ' || _safe_reference || ' est confirmée.</p>'
          WHEN 'mission_delivered' THEN '<p>La mission ' || _safe_reference || ' est livrée.</p>'
          WHEN 'mission_cancelled' THEN '<p>La mission ' || _safe_reference || ' est annulée.</p>'
          ELSE '<p>Notification concernant la mission ' || _safe_reference || '</p>'
        END;

        -- Freeze du payload : to, subject, body figés
        -- attempts NON incrémenté, sent_at NON positionné
        UPDATE public.notification_outbox AS no
        SET status = 'prepared',
            prepared_at = now(),
            sent_at = NULL,
            last_error = NULL,
            payload = _row.payload || jsonb_build_object('to', _to_email, 'subject', _subject, 'body', _body)
        WHERE no.id = _row.id;

        RETURN QUERY SELECT _row.id, 'prepared', _row.attempts, NULL::text;

      -- -----------------------------------------------------
      -- CAS 2 : retry — re-préparation avec payload figé
      -- -----------------------------------------------------
      ELSIF _row.status = 'retry' THEN
        -- Vérifier que le payload contient déjà les champs figés
        IF _row.payload ? 'to' AND _row.payload ? 'subject' AND _row.payload ? 'body' THEN
          -- Réutiliser exactement le payload existant — ne pas recalculer
          -- attempts NON incrémenté, sent_at NON positionné
          UPDATE public.notification_outbox AS no
          SET status = 'prepared',
              prepared_at = now(),
              sent_at = NULL,
              last_error = NULL
          WHERE no.id = _row.id;

          RETURN QUERY SELECT _row.id, 'prepared', _row.attempts, NULL::text;
        ELSE
          -- Payload incomplet sur une row retry : échec terminal
          UPDATE public.notification_outbox AS no
          SET status = 'failed',
              prepared_at = NULL,
              sent_at = NULL,
              last_error = 'Payload figé incomplet — champs to/subject/body manquants'
          WHERE no.id = _row.id;

          RETURN QUERY SELECT _row.id, 'failed', _row.attempts, 'Payload figé incomplet'::text;
        END IF;

      -- -----------------------------------------------------
      -- CAS 3 : prepared stale — lease expirée, reclaim
      -- -----------------------------------------------------
      ELSIF _row.status = 'prepared' THEN
        -- Vérifier que le payload contient toujours les champs figés
        IF _row.payload ? 'to' AND _row.payload ? 'subject' AND _row.payload ? 'body' THEN
          -- Ne pas reconstruire le payload, juste rafraîchir le lease
          -- attempts NON incrémenté
          UPDATE public.notification_outbox AS no
          SET prepared_at = now()
          WHERE no.id = _row.id;

          RETURN QUERY SELECT _row.id, 'prepared', _row.attempts, NULL::text;
        ELSE
          -- Payload incomplet sur une row prepared stale : échec terminal
          UPDATE public.notification_outbox AS no
          SET status = 'failed',
              prepared_at = NULL,
              sent_at = NULL,
              last_error = 'Payload figé incomplet — champs to/subject/body manquants'
          WHERE no.id = _row.id;

          RETURN QUERY SELECT _row.id, 'failed', _row.attempts, 'Payload figé incomplet'::text;
        END IF;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      UPDATE public.notification_outbox AS no
      SET status = 'failed', prepared_at = NULL, last_error = SQLERRM
      WHERE no.id = _row.id;
      RETURN QUERY SELECT _row.id, 'failed', _row.attempts, SQLERRM;
    END;
  END LOOP;
END;
$$;

-- =========================================================
-- AUTORISATION — SERVICE_ROLE ONLY (répétée après REPLACE)
-- =========================================================

REVOKE EXECUTE ON FUNCTION public.process_notification_outbox(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.process_notification_outbox(int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.process_notification_outbox(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_notification_outbox(int) TO service_role;
