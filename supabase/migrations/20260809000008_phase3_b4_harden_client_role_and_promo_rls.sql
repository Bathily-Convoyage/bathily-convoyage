-- =========================================================
-- Phase 3 B4 — Hardening RLS : clients.role + promo_codes
-- =========================================================
-- Corrige deux vulnérabilités CRITICAL identifiées par
-- C-SEC-REVALIDATION indépendante :
--
-- 1. Escalade de privilèges via clients.role
--    Un client authentifié pouvait UPDATE clients SET role='admin'
--    sur sa propre ligne (policy clients_update_own_strict).
--    Après modification, is_admin() retournait vrai.
--
-- 2. promo_codes_admin_all accordait ALL (INSERT/UPDATE/DELETE)
--    à tout utilisateur authenticated sans vérification is_admin().
--
-- Stratégie :
--   a) Trigger BEFORE INSERT OR UPDATE sur clients qui empêche
--      tout non-admin de modifier les colonnes privilégiées :
--      role, banned, notes_admin, auth_user_id, is_pro, pro_status.
--   b) Trigger AFTER INSERT OR UPDATE sur clients qui synchronise
--      user_roles quand clients.role = 'admin' (pour convergence
--      future vers user_roles comme seule source d'autorité).
--   c) Remplacement de promo_codes_admin_all par une policy
--      restreinte à is_admin().
-- =========================================================

BEGIN;

-- =========================================================
-- 1. FONCTION DE GARDE : guard_clients_privileged_fields
-- =========================================================
-- Sécurise les colonnes administratives de la table clients.
-- Appelée BEFORE INSERT OR UPDATE.
--
-- Règles :
--   - service_role / postgres (auth.uid() IS NULL) : tout permis
--   - admin (is_admin() = true) : tout permis
--   - non-admin :
--       UPDATE : refuse toute modification de role, banned,
--                 notes_admin, auth_user_id, is_pro, pro_status
--       INSERT : refuse role='admin', banned=true, is_pro=true,
--                pro_status='approved', notes_admin non vide
-- =========================================================

CREATE OR REPLACE FUNCTION public.guard_clients_privileged_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _is_admin boolean;
BEGIN
  -- service_role / postgres (pas de auth.uid()) : tout permis
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  _is_admin := public.is_admin();

  -- Admin reconnu : tout permis
  IF _is_admin THEN
    RETURN NEW;
  END IF;

  -- ---- Non-admin : protéger les colonnes privilégiées ----

  IF TG_OP = 'UPDATE' THEN
    -- role : interdit de changer
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'Non autorisé : modification de role interdite'
        USING ERRCODE = '42501';
    END IF;

    -- banned : interdit de changer
    IF NEW.banned IS DISTINCT FROM OLD.banned THEN
      RAISE EXCEPTION 'Non autorisé : modification de banned interdite'
        USING ERRCODE = '42501';
    END IF;

    -- notes_admin : interdit de changer
    IF NEW.notes_admin IS DISTINCT FROM OLD.notes_admin THEN
      RAISE EXCEPTION 'Non autorisé : modification de notes_admin interdite'
        USING ERRCODE = '42501';
    END IF;

    -- auth_user_id : interdit de changer
    IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
      RAISE EXCEPTION 'Non autorisé : modification de auth_user_id interdite'
        USING ERRCODE = '42501';
    END IF;

    -- is_pro : interdit de changer
    IF NEW.is_pro IS DISTINCT FROM OLD.is_pro THEN
      RAISE EXCEPTION 'Non autorisé : modification de is_pro interdite'
        USING ERRCODE = '42501';
    END IF;

    -- pro_status : interdit de changer
    IF NEW.pro_status IS DISTINCT FROM OLD.pro_status THEN
      RAISE EXCEPTION 'Non autorisé : modification de pro_status interdite'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- role : interdit d'insérer avec 'admin'
    IF NEW.role = 'admin' THEN
      RAISE EXCEPTION 'Non autorisé : insertion avec role admin interdite'
        USING ERRCODE = '42501';
    END IF;

    -- banned : interdit d'insérer avec banned=true
    IF NEW.banned = true THEN
      RAISE EXCEPTION 'Non autorisé : insertion avec banned=true interdite'
        USING ERRCODE = '42501';
    END IF;

    -- is_pro : interdit d'insérer avec is_pro=true
    IF NEW.is_pro = true THEN
      RAISE EXCEPTION 'Non autorisé : insertion avec is_pro=true interdite'
        USING ERRCODE = '42501';
    END IF;

    -- pro_status : interdit d'insérer avec pro_status='approved'
    IF NEW.pro_status = 'approved' THEN
      RAISE EXCEPTION 'Non autorisé : insertion avec pro_status=approved interdite'
        USING ERRCODE = '42501';
    END IF;

    -- notes_admin : interdit d'insérer avec notes_admin non vide
    IF NEW.notes_admin IS NOT NULL AND NEW.notes_admin <> '' THEN
      RAISE EXCEPTION 'Non autorisé : insertion avec notes_admin interdite'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_clients_privileged_fields() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.guard_clients_privileged_fields() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guard_clients_privileged_fields() TO authenticated;

-- Trigger BEFORE INSERT OR UPDATE
DROP TRIGGER IF EXISTS trg_guard_clients_privileged_fields ON public.clients;
CREATE TRIGGER trg_guard_clients_privileged_fields
  BEFORE INSERT OR UPDATE ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_clients_privileged_fields();

-- =========================================================
-- 2. SYNC user_roles quand clients.role = 'admin'
-- =========================================================
-- Garantit que user_roles reste synchronisé avec clients.role.
-- Quand un admin crée/modifie un client avec role='admin',
-- la ligne correspondante est ajoutée à user_roles.
-- Quand role passe de 'admin' à autre chose, la ligne est retirée.
-- Cela prépare la convergence vers user_roles comme seule source
-- d'autorité pour is_admin().
-- =========================================================

CREATE OR REPLACE FUNCTION public.sync_user_roles_on_client_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.role = 'admin' AND NEW.auth_user_id IS NOT NULL THEN
      INSERT INTO public.user_roles (user_id, role)
      VALUES (NEW.auth_user_id, 'admin')
      ON CONFLICT (user_id, role) DO NOTHING;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- role a changé
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      IF NEW.role = 'admin' AND NEW.auth_user_id IS NOT NULL THEN
        INSERT INTO public.user_roles (user_id, role)
        VALUES (NEW.auth_user_id, 'admin')
        ON CONFLICT (user_id, role) DO NOTHING;
      END IF;
      -- Si l'ancien rôle était admin et le nouveau ne l'est plus,
      -- retirer de user_roles (uniquement si pas d'autre ligne admin)
      IF OLD.role = 'admin' AND NEW.role <> 'admin' AND OLD.auth_user_id IS NOT NULL THEN
        DELETE FROM public.user_roles
        WHERE user_id = OLD.auth_user_id
          AND role = 'admin'
          AND NOT EXISTS (
            SELECT 1 FROM public.clients c
            WHERE c.auth_user_id = OLD.auth_user_id
              AND c.role = 'admin'
              AND c.id <> NEW.id
          );
      END IF;
    END IF;

    -- auth_user_id a changé (par un admin)
    IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
      IF NEW.role = 'admin' AND NEW.auth_user_id IS NOT NULL THEN
        INSERT INTO public.user_roles (user_id, role)
        VALUES (NEW.auth_user_id, 'admin')
        ON CONFLICT (user_id, role) DO NOTHING;
      END IF;
      IF OLD.role = 'admin' AND OLD.auth_user_id IS NOT NULL THEN
        DELETE FROM public.user_roles
        WHERE user_id = OLD.auth_user_id
          AND role = 'admin'
          AND NOT EXISTS (
            SELECT 1 FROM public.clients c
            WHERE c.auth_user_id = OLD.auth_user_id
              AND c.role = 'admin'
          );
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.sync_user_roles_on_client_role() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.sync_user_roles_on_client_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_user_roles_on_client_role() TO authenticated;

-- Trigger AFTER INSERT OR UPDATE
DROP TRIGGER IF EXISTS trg_sync_user_roles_on_client_role ON public.clients;
CREATE TRIGGER trg_sync_user_roles_on_client_role
  AFTER INSERT OR UPDATE ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_user_roles_on_client_role();

-- =========================================================
-- 3. FIX promo_codes_admin_all
-- =========================================================
-- Avant : USING (true) WITH CHECK (true) — tout authenticated
--         pouvait INSERT/UPDATE/DELETE.
-- Après : USING (is_admin()) WITH CHECK (is_admin()) — seuls
--         les admins peuvent écrire.
-- promo_codes_public_read est conservée inchangée.
-- =========================================================

DROP POLICY IF EXISTS "promo_codes_admin_all" ON public.promo_codes;
CREATE POLICY "promo_codes_admin_write" ON public.promo_codes
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

COMMIT;
