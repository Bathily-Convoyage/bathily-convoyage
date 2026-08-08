-- =====================================================
-- Migration: phase1_roles_security_foundation
-- Timestamp: 20260807215028
-- =====================================================
-- Objectifs :
-- 1. Créer public.user_roles (rôles admin/operator uniquement)
-- 2. Créer public.internal_operators (opérateurs internes)
-- 3. Modifier is_admin() pour transition depuis user_roles + clients.role
-- 4. Créer is_operator() (3 conditions)
-- 5. Corriger admin_delete_user avec check is_admin() en première opération
-- 6. Données initiales atomiques pour le compte dirigeant (conditionnel)
-- 7. Vérifications transactionnelles pour rollback
-- =====================================================
-- PORTABLE : Cette migration réussit sur une base locale neuve
--            sans utilisateur Auth. Les insertions du dirigeant
--            sont conditionnées par l'existence du compte dans auth.users.
-- =====================================================

BEGIN;

-- =========================================================
-- 0. PRÉCONDITIONS AU DÉBUT DE LA TRANSACTION
-- =========================================================

DO $preconditions$
BEGIN
  -- public.user_roles ne doit pas déjà exister
  IF pg_catalog.to_regclass('public.user_roles') IS NOT NULL THEN
    RAISE EXCEPTION 'public.user_roles already exists — schema drift detected'
      USING ERRCODE = 'P0001';
  END IF;

  -- public.internal_operators ne doit pas déjà exister
  IF pg_catalog.to_regclass('public.internal_operators') IS NOT NULL THEN
    RAISE EXCEPTION 'public.internal_operators already exists — schema drift detected'
      USING ERRCODE = 'P0001';
  END IF;

  -- public.is_admin() doit exister (signature sans paramètres)
  IF pg_catalog.to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'public.is_admin() signature not found — cannot replace'
      USING ERRCODE = 'P0001';
  END IF;

  -- public.admin_delete_user(uuid, text) doit exister
  IF pg_catalog.to_regprocedure('public.admin_delete_user(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'public.admin_delete_user(uuid, text) signature not found — cannot replace'
      USING ERRCODE = 'P0001';
  END IF;
END $preconditions$;

-- =========================================================
-- 1. TABLE public.user_roles
-- =========================================================

CREATE TABLE public.user_roles (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role),
  CHECK (role IN ('admin', 'operator'))
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Révoquer tous les privilèges directs
REVOKE ALL ON public.user_roles FROM PUBLIC;
REVOKE ALL ON public.user_roles FROM anon;
REVOKE ALL ON public.user_roles FROM authenticated;

-- Aucune policy d'écriture utilisateur dans cette migration

-- =========================================================
-- 2. TABLE public.internal_operators
-- =========================================================

CREATE TABLE public.internal_operators (
  user_id      uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text        NOT NULL,
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.internal_operators ENABLE ROW LEVEL SECURITY;

-- Révoquer tous les privilèges directs
REVOKE ALL ON public.internal_operators FROM PUBLIC;
REVOKE ALL ON public.internal_operators FROM anon;
REVOKE ALL ON public.internal_operators FROM authenticated;

-- Aucune policy d'écriture directe utilisateur dans cette migration

-- =========================================================
-- 3. DONNÉES INITIALES ATOMIQUES (CONDITIONNELLES)
-- =========================================================
-- Compte dirigeant : bf2a5ff5-ab35-499c-b564-b35e5eb49650
-- Les insertions ne se produisent que si le compte existe dans auth.users.
-- Sur une base locale neuve sans utilisateur Auth, aucune ligne n'est insérée.
-- =========================================================

-- Insérer les admins légitimes depuis clients (idempotent)
INSERT INTO public.user_roles (user_id, role)
SELECT c.auth_user_id, 'admin'
FROM public.clients c
WHERE c.role = 'admin'
  AND c.auth_user_id IS NOT NULL
ON CONFLICT (user_id, role) DO NOTHING;

-- Insérer conditionnellement le compte dirigeant avec les deux rôles
INSERT INTO public.user_roles (user_id, role)
SELECT u.id, r.role
FROM auth.users u
CROSS JOIN (
  VALUES ('admin'::text), ('operator'::text)
) AS r(role)
WHERE u.id = 'bf2a5ff5-ab35-499c-b564-b35e5eb49650'
ON CONFLICT (user_id, role) DO NOTHING;

-- Insérer conditionnellement dans internal_operators
INSERT INTO public.internal_operators (user_id, display_name, active)
SELECT u.id, 'Bathily Boubacar', true
FROM auth.users u
WHERE u.id = 'bf2a5ff5-ab35-499c-b564-b35e5eb49650'
ON CONFLICT (user_id) DO NOTHING;

-- =========================================================
-- 4. MODIFIER is_admin()
-- =========================================================
-- Reconnaît l'admin depuis user_roles (nouveau) OU clients.role (legacy)
-- Signature conservée : public.is_admin()
-- search_path = '', références qualifiées

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.role = 'admin'
      AND ur.user_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM public.clients c
    WHERE c.role = 'admin'
      AND c.auth_user_id = auth.uid()
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- =========================================================
-- 5. CRÉER is_operator()
-- =========================================================
-- Retourne true uniquement si :
-- 1. auth.uid() possède le rôle 'operator' dans user_roles
-- 2. une ligne correspondante existe dans internal_operators
-- 3. internal_operators.active = true

CREATE OR REPLACE FUNCTION public.is_operator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.internal_operators io ON io.user_id = ur.user_id
    WHERE ur.role = 'operator'
      AND ur.user_id = auth.uid()
      AND io.active = true
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_operator() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_operator() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_operator() TO authenticated;

-- =========================================================
-- 6. CORRIGER admin_delete_user
-- =========================================================
-- Signature exacte de production conservée.
-- Ajout du check is_admin() en PREMIÈRE opération du corps.
-- Aucun UPDATE/DELETE ne peut être atteint avant ce contrôle.

CREATE OR REPLACE FUNCTION public.admin_delete_user(target_id uuid, target_table text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized'
      USING ERRCODE = '42501';
  END IF;

  IF target_table = 'clients' THEN
    UPDATE public.missions SET client_id = NULL WHERE client_id = target_id;
    DELETE FROM public.support_tickets WHERE client_id = target_id;
    DELETE FROM public.clients WHERE id = target_id;
  ELSIF target_table = 'convoyeurs' THEN
    DECLARE
      nom_complet text;
    BEGIN
      SELECT (prenom || ' ' || nom) INTO nom_complet
      FROM public.convoyeurs WHERE id = target_id;

      UPDATE public.missions
        SET convoyeur_nom = NULL, convoyeur_id = NULL, status = 'available'
        WHERE convoyeur_id = target_id;

      DELETE FROM public.candidatures WHERE convoyeur_id = target_id;
      DELETE FROM public.candidatures WHERE convoyeur_nom = nom_complet;

      DELETE FROM public.convoyeurs WHERE id = target_id;
    END;
  ELSE
    RAISE EXCEPTION 'Table non supportée : %', target_table;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, text) TO authenticated;

-- =========================================================
-- 7. VÉRIFICATIONS TRANSACTIONNELLES
-- =========================================================
-- Déclenche un RAISE EXCEPTION si une condition n'est pas remplie.
-- Les vérifications structurelles et de sécurité sont OBLIGATOIRES
-- dans tous les environnements.
-- Les vérifications du dirigeant sont CONDITIONNELLES à l'existence
-- du compte dans auth.users.
-- =========================================================

DO $verify$
BEGIN
  -- -------------------------------------------------------
  -- 7.1 Tables créées
  -- -------------------------------------------------------
  IF pg_catalog.to_regclass('public.user_roles') IS NULL THEN
    RAISE EXCEPTION 'user_roles table not created'
      USING ERRCODE = 'P0001';
  END IF;

  IF pg_catalog.to_regclass('public.internal_operators') IS NULL THEN
    RAISE EXCEPTION 'internal_operators table not created'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------
  -- 7.2 RLS activée sur les deux tables
  -- -------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = 'user_roles'
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on user_roles'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = 'internal_operators'
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on internal_operators'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------
  -- 7.3 Vérification structurelle du CHECK constraint sur user_roles.role
  -- -------------------------------------------------------
  -- Vérification obligatoire dans tous les environnements.
  -- Utilise pg_catalog.pg_get_constraintdef() pour confirmer
  -- qu'une contrainte CHECK existe et limite les valeurs à
  -- 'admin' et 'operator'. Une FK invalide n'est jamais une
  -- preuve suffisante.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
    JOIN pg_catalog.pg_namespace nsp ON nsp.oid = cls.relnamespace
    WHERE nsp.nspname = 'public'
      AND cls.relname = 'user_roles'
      AND con.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(con.oid) LIKE '%admin%'
      AND pg_catalog.pg_get_constraintdef(con.oid) LIKE '%operator%'
  ) THEN
    RAISE EXCEPTION 'user_roles CHECK constraint on role column not found or does not enforce admin/operator'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------
  -- 7.3.1 Test fonctionnel du CHECK (CONDITIONNEL)
  -- -------------------------------------------------------
  -- Réalisé uniquement si au moins un utilisateur existe dans
  -- auth.users. Utilise l'UUID réel de cet utilisateur pour
  -- tenter l'insertion d'un rôle invalide.
  -- Résultat obligatoire : SQLSTATE 23514 (check_violation).
  -- foreign_key_violation n'est PAS accepté comme succès.
  -- Aucune ligne ne doit persister (rollback sur exception).
  IF EXISTS (SELECT 1 FROM auth.users LIMIT 1) THEN
    BEGIN
      INSERT INTO public.user_roles (user_id, role)
      SELECT u.id, '__invalid_role_test__'
      FROM auth.users u
      LIMIT 1;
      -- Si on arrive ici, le CHECK n'a pas rejeté l'insertion
      RAISE EXCEPTION 'user_roles CHECK constraint failed to reject invalid role __invalid_role_test__'
        USING ERRCODE = 'P0001';
    EXCEPTION
      WHEN check_violation THEN
        -- Comportement attendu : le CHECK a rejeté l'insertion
        NULL;
      WHEN foreign_key_violation THEN
        -- Une FK invalide n'est PAS une preuve que le CHECK fonctionne
        RAISE EXCEPTION 'user_roles CHECK test raised foreign_key_violation, not check_violation — CHECK may be missing'
          USING ERRCODE = 'P0001';
    END;
  END IF;

  -- -------------------------------------------------------
  -- 7.4 Vérifications du dirigeant (CONDITIONNELLES)
  --     Uniquement si le compte existe dans auth.users.
  -- -------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = 'bf2a5ff5-ab35-499c-b564-b35e5eb49650'
  ) THEN
    -- Rôle admin obligatoire
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = 'bf2a5ff5-ab35-499c-b564-b35e5eb49650'
        AND role = 'admin'
    ) THEN
      RAISE EXCEPTION 'Dirigeant admin role missing from user_roles'
        USING ERRCODE = 'P0001';
    END IF;

    -- Rôle operator obligatoire
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = 'bf2a5ff5-ab35-499c-b564-b35e5eb49650'
        AND role = 'operator'
    ) THEN
      RAISE EXCEPTION 'Dirigeant operator role missing from user_roles'
        USING ERRCODE = 'P0001';
    END IF;

    -- Profil opérateur interne obligatoire
    IF NOT EXISTS (
      SELECT 1 FROM public.internal_operators
      WHERE user_id = 'bf2a5ff5-ab35-499c-b564-b35e5eb49650'
    ) THEN
      RAISE EXCEPTION 'Dirigeant internal_operators profile missing'
        USING ERRCODE = 'P0001';
    END IF;

    -- Opérateur doit être actif
    IF NOT EXISTS (
      SELECT 1 FROM public.internal_operators
      WHERE user_id = 'bf2a5ff5-ab35-499c-b564-b35e5eb49650'
        AND active = true
    ) THEN
      RAISE EXCEPTION 'Dirigeant internal_operators profile not active'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- -------------------------------------------------------
  -- 7.5 Absence de rôles autres que admin et operator
  -- -------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE role NOT IN ('admin', 'operator')
  ) THEN
    RAISE EXCEPTION 'user_roles contains roles other than admin and operator'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------
  -- 7.6 Signatures exactes des fonctions
  -- -------------------------------------------------------
  IF pg_catalog.to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'is_admin() signature not found after migration'
      USING ERRCODE = 'P0001';
  END IF;

  IF pg_catalog.to_regprocedure('public.is_operator()') IS NULL THEN
    RAISE EXCEPTION 'is_operator() signature not found after migration'
      USING ERRCODE = 'P0001';
  END IF;

  IF pg_catalog.to_regprocedure('public.admin_delete_user(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'admin_delete_user(uuid, text) signature not found after migration'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------
  -- 7.7 admin_delete_user contient le contrôle is_admin()
  -- -------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'admin_delete_user'
      AND p.prosrc LIKE '%public.is_admin()%'
      AND p.prosrc LIKE '%42501%'
  ) THEN
    RAISE EXCEPTION 'admin_delete_user() does not contain is_admin() check with ERRCODE 42501'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------
  -- 7.8 Absence de privilèges INSERT/UPDATE/DELETE pour authenticated
  -- -------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name IN ('user_roles', 'internal_operators')
      AND grantee = 'authenticated'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'authenticated has direct INSERT/UPDATE/DELETE on new tables'
      USING ERRCODE = 'P0001';
  END IF;

  -- -------------------------------------------------------
  -- 7.9 Vérification des privilèges EXECUTE via ACL
  -- -------------------------------------------------------

  -- 7.9.1 public.is_admin() : PUBLIC non, anon oui, authenticated oui
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    WHERE n.nspname = 'public' AND p.proname = 'is_admin'
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC still has EXECUTE on is_admin()'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public' AND p.proname = 'is_admin'
      AND r.rolname = 'anon'
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon does not have EXECUTE on is_admin()'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public' AND p.proname = 'is_admin'
      AND r.rolname = 'authenticated'
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated does not have EXECUTE on is_admin()'
      USING ERRCODE = 'P0001';
  END IF;

  -- 7.9.2 public.is_operator() : PUBLIC non, anon non, authenticated oui
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    WHERE n.nspname = 'public' AND p.proname = 'is_operator'
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC still has EXECUTE on is_operator()'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public' AND p.proname = 'is_operator'
      AND r.rolname = 'anon'
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon still has EXECUTE on is_operator()'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public' AND p.proname = 'is_operator'
      AND r.rolname = 'authenticated'
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated does not have EXECUTE on is_operator()'
      USING ERRCODE = 'P0001';
  END IF;

  -- 7.9.3 public.admin_delete_user(uuid, text) :
  --   PUBLIC non, anon non, authenticated oui, service_role non
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    WHERE n.nspname = 'public' AND p.proname = 'admin_delete_user'
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC still has EXECUTE on admin_delete_user()'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public' AND p.proname = 'admin_delete_user'
      AND r.rolname = 'anon'
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon still has EXECUTE on admin_delete_user()'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public' AND p.proname = 'admin_delete_user'
      AND r.rolname = 'authenticated'
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated does not have EXECUTE on admin_delete_user()'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public' AND p.proname = 'admin_delete_user'
      AND r.rolname = 'service_role'
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role still has explicit EXECUTE grant on admin_delete_user()'
      USING ERRCODE = 'P0001';
  END IF;
END $verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
