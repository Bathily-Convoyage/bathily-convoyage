-- ============================================================
--  C-2.4A — Outbox Security Hardening + RPC mark_mission_paid
--  Phase 3 / Security Offensive Audit
--  Baseline: 23f4923b19b5f07aaa047f8130945d80921fe592
-- ============================================================

-- ============================================================
--  1. SÉCURISATION notification_outbox
-- ============================================================

-- 1a. Activer RLS + FORCER RLS
ALTER TABLE public.notification_outbox
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notification_outbox
  FORCE ROW LEVEL SECURITY;

-- 1b. Révoquer TOUS les droits des rôles non-service
REVOKE ALL ON TABLE public.notification_outbox
  FROM anon, authenticated;

-- Note: service_role et postgres conservent leurs droits.
-- service_role est un superuser → bypass RLS.
-- Aucune policy anon/authenticated créée.
-- Le RPC process_notification_outbox (SECURITY DEFINER, owner=postgres)
-- bypass RLS car postgres est superuser.

-- ============================================================
--  2. RPC mark_mission_paid
-- ============================================================

CREATE OR REPLACE FUNCTION public.mark_mission_paid(p_mission_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  -- Vérifier l'authentification
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Non autorisé'
      USING ERRCODE = '42501';
  END IF;

  -- Vérifier le rôle admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Non autorisé'
      USING ERRCODE = '42501';
  END IF;

  -- Vérifier l'existence de la mission
  IF NOT EXISTS (SELECT 1 FROM public.missions WHERE id = p_mission_id) THEN
    RAISE EXCEPTION 'Mission introuvable'
      USING ERRCODE = 'P0002';
  END IF;

  -- Mettre à jour uniquement paiement_statut
  -- Le trigger missions_sensitive_protect ne s'applique pas car
  -- current_user = 'postgres' (SECURITY DEFINER)
  UPDATE public.missions
  SET paiement_statut = 'paid'
  WHERE id = p_mission_id;
END;
$function$;

-- 2a. Grants RPC
REVOKE EXECUTE ON FUNCTION public.mark_mission_paid(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_mission_paid(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_mission_paid(uuid) TO authenticated;
