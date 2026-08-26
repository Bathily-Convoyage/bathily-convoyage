BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Serialize role/profile changes while the one-time Production cleanup runs.
-- Dependency tables are locked only long enough to prove that the operator's
-- empty convoyeur profile can be removed safely.
LOCK TABLE public.clients,
  public.convoyeurs,
  public.internal_operators,
  public.user_roles
  IN SHARE ROW EXCLUSIVE MODE;

LOCK TABLE public.candidatures,
  public.missions,
  public.support_tickets
  IN SHARE MODE;

DO $migration$
DECLARE
  -- Stable Auth identifier for the dedicated convoyeur account created and
  -- confirmed during the P4.2 preflight. The email is read from auth.users so
  -- no personal address is committed to the repository.
  target_auth_user_id CONSTANT uuid := '2ecef63a-73fb-4d99-b556-c080ff882ec6';
  target_email text;
  target_count integer;
  target_confirmed_count integer;
  admin_profile_ids uuid[];
  operator_profile_ids uuid[];
  real_profile_id uuid;
  empty_operator_profile_id uuid;
  affected_rows integer;
BEGIN
  SELECT count(*),
    (array_agg(u.email ORDER BY u.email))[1],
    count(*) FILTER (WHERE u.confirmed_at IS NOT NULL)
  INTO target_count, target_email, target_confirmed_count
  FROM auth.users u
  WHERE u.id = target_auth_user_id
    AND u.deleted_at IS NULL;

  -- A clean local database has no environment-specific Auth rows. In that
  -- case, install only the durable guards below. If collisions exist without
  -- the preflighted target, fail closed instead of guessing an identity.
  IF target_count = 0 THEN
    IF EXISTS (
      SELECT 1
      FROM public.clients c
      JOIN public.convoyeurs v ON v.auth_user_id = c.auth_user_id
      WHERE c.auth_user_id IS NOT NULL
    ) OR EXISTS (
      SELECT 1
      FROM public.clients c
      JOIN public.internal_operators o ON o.user_id = c.auth_user_id
      WHERE c.auth_user_id IS NOT NULL
    ) OR EXISTS (
      SELECT 1
      FROM public.convoyeurs v
      JOIN public.internal_operators o ON o.user_id = v.auth_user_id
      WHERE v.auth_user_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'P4.2 target Auth user is missing while cross-role collisions still exist'
        USING ERRCODE = '23503';
    END IF;

    RAISE NOTICE 'P4.2 target Auth user absent and no collision found; applying schema guards only';
    RETURN;
  END IF;

  IF target_count <> 1 OR target_confirmed_count <> 1 OR target_email IS NULL THEN
    RAISE EXCEPTION 'P4.2 target Auth user must exist exactly once and be confirmed'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (SELECT 1 FROM public.clients c WHERE c.auth_user_id = target_auth_user_id)
    OR EXISTS (SELECT 1 FROM public.convoyeurs v WHERE v.auth_user_id = target_auth_user_id)
    OR EXISTS (SELECT 1 FROM public.internal_operators o WHERE o.user_id = target_auth_user_id)
    OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = target_auth_user_id)
  THEN
    RAISE EXCEPTION 'P4.2 target Auth user already has a role or profile'
      USING ERRCODE = '23505';
  END IF;

  SELECT array_agg(v.id ORDER BY v.id)
  INTO admin_profile_ids
  FROM public.convoyeurs v
  WHERE v.auth_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.clients c
      WHERE c.auth_user_id = v.auth_user_id
        AND c.role = 'admin'
    )
    AND EXISTS (
      SELECT 1
      FROM public.user_roles r
      WHERE r.user_id = v.auth_user_id
        AND r.role = 'admin'
    );

  IF cardinality(coalesce(admin_profile_ids, ARRAY[]::uuid[])) <> 1 THEN
    RAISE EXCEPTION 'P4.2 expected exactly one admin-linked convoyeur profile'
      USING ERRCODE = '23514';
  END IF;
  real_profile_id := admin_profile_ids[1];

  IF NOT EXISTS (
    SELECT 1 FROM public.missions m WHERE m.convoyeur_id = real_profile_id
  ) THEN
    RAISE EXCEPTION 'P4.2 refuses to transfer an admin-linked profile without mission history'
      USING ERRCODE = '23514';
  END IF;

  SELECT array_agg(v.id ORDER BY v.id)
  INTO operator_profile_ids
  FROM public.convoyeurs v
  WHERE v.auth_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.internal_operators o WHERE o.user_id = v.auth_user_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.user_roles r
      WHERE r.user_id = v.auth_user_id
        AND r.role = 'operator'
    );

  IF cardinality(coalesce(operator_profile_ids, ARRAY[]::uuid[])) <> 1 THEN
    RAISE EXCEPTION 'P4.2 expected exactly one operator-linked convoyeur profile'
      USING ERRCODE = '23514';
  END IF;
  empty_operator_profile_id := operator_profile_ids[1];

  IF empty_operator_profile_id = real_profile_id THEN
    RAISE EXCEPTION 'P4.2 source profiles unexpectedly resolve to the same row'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.missions m WHERE m.convoyeur_id = empty_operator_profile_id
  ) OR EXISTS (
    SELECT 1 FROM public.candidatures c WHERE c.convoyeur_id = empty_operator_profile_id
  ) OR EXISTS (
    SELECT 1 FROM public.support_tickets s WHERE s.convoyeur_id = empty_operator_profile_id
  ) THEN
    RAISE EXCEPTION 'P4.2 refuses to remove an operator-linked profile with dependencies'
      USING ERRCODE = '23503';
  END IF;

  -- Preserve the real convoyeur profile id so every mission, event and piece of
  -- evidence remains attached. Only its Auth owner and login email change.
  UPDATE public.convoyeurs
  SET auth_user_id = target_auth_user_id,
      email = target_email,
      updated_at = now()
  WHERE id = real_profile_id;

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'P4.2 real convoyeur profile transfer affected % rows', affected_rows
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.convoyeurs
  WHERE id = empty_operator_profile_id;

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'P4.2 empty operator convoyeur profile removal affected % rows', affected_rows
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.clients c
    JOIN public.convoyeurs v ON v.auth_user_id = c.auth_user_id
    WHERE c.auth_user_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.clients c
    JOIN public.internal_operators o ON o.user_id = c.auth_user_id
    WHERE c.auth_user_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.convoyeurs v
    JOIN public.internal_operators o ON o.user_id = v.auth_user_id
    WHERE v.auth_user_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.user_roles r
    JOIN public.convoyeurs v ON v.auth_user_id = r.user_id
    WHERE r.role IN ('admin', 'operator')
  ) OR EXISTS (
    SELECT 1
    FROM public.user_roles r
    JOIN public.clients c ON c.auth_user_id = r.user_id
    WHERE r.role = 'operator'
  ) OR EXISTS (
    SELECT 1
    FROM public.user_roles r
    JOIN public.internal_operators o ON o.user_id = r.user_id
    WHERE r.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'P4.2 cross-role collision remains after cleanup'
      USING ERRCODE = '23514';
  END IF;
END
$migration$;

-- A cross-table CHECK constraint cannot express this invariant. This private
-- trigger function serializes changes for the same Auth user and rejects every
-- client/admin, operator or convoyeur overlap before it reaches storage.
CREATE OR REPLACE FUNCTION public.enforce_auth_role_separation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  checked_user_id uuid;
  checked_role text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' THEN
    RAISE EXCEPTION 'Unexpected schema for role-separation trigger'
      USING ERRCODE = 'P0001';
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'clients' THEN
      checked_user_id := NEW.auth_user_id;
    WHEN 'convoyeurs' THEN
      checked_user_id := NEW.auth_user_id;
    WHEN 'internal_operators' THEN
      checked_user_id := NEW.user_id;
    WHEN 'user_roles' THEN
      checked_user_id := NEW.user_id;
      checked_role := NEW.role;
    ELSE
      RAISE EXCEPTION 'Unexpected table for role-separation trigger: %', TG_TABLE_NAME
        USING ERRCODE = 'P0001';
  END CASE;

  IF checked_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- All four trigger paths take the same transaction-scoped lock, preventing
  -- concurrent inserts into different tables from both observing an empty role.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(checked_user_id::text, 42002)
  );

  IF TG_TABLE_NAME = 'clients' THEN
    IF EXISTS (SELECT 1 FROM public.convoyeurs v WHERE v.auth_user_id = checked_user_id)
      OR EXISTS (SELECT 1 FROM public.internal_operators o WHERE o.user_id = checked_user_id)
      OR EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.user_id = checked_user_id AND r.role = 'operator'
      )
    THEN
      RAISE EXCEPTION 'Auth user already belongs to an operator or convoyeur role'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'convoyeurs' THEN
    IF EXISTS (SELECT 1 FROM public.clients c WHERE c.auth_user_id = checked_user_id)
      OR EXISTS (SELECT 1 FROM public.internal_operators o WHERE o.user_id = checked_user_id)
      OR EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.user_id = checked_user_id AND r.role IN ('admin', 'operator')
      )
    THEN
      RAISE EXCEPTION 'Auth user already belongs to a client, admin or operator role'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'internal_operators' THEN
    IF EXISTS (SELECT 1 FROM public.clients c WHERE c.auth_user_id = checked_user_id)
      OR EXISTS (SELECT 1 FROM public.convoyeurs v WHERE v.auth_user_id = checked_user_id)
      OR EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.user_id = checked_user_id AND r.role = 'admin'
      )
    THEN
      RAISE EXCEPTION 'Auth user already belongs to a client, admin or convoyeur role'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'user_roles' THEN
    IF checked_role = 'admin' AND (
      EXISTS (SELECT 1 FROM public.convoyeurs v WHERE v.auth_user_id = checked_user_id)
      OR EXISTS (SELECT 1 FROM public.internal_operators o WHERE o.user_id = checked_user_id)
      OR EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.user_id = checked_user_id AND r.role = 'operator'
      )
    ) THEN
      RAISE EXCEPTION 'Auth user already belongs to an operator or convoyeur role'
        USING ERRCODE = '23514';
    ELSIF checked_role = 'operator' AND (
      EXISTS (SELECT 1 FROM public.clients c WHERE c.auth_user_id = checked_user_id)
      OR EXISTS (SELECT 1 FROM public.convoyeurs v WHERE v.auth_user_id = checked_user_id)
      OR EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.user_id = checked_user_id AND r.role = 'admin'
      )
    ) THEN
      RAISE EXCEPTION 'Auth user already belongs to a client, admin or convoyeur role'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.enforce_auth_role_separation() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.enforce_auth_role_separation()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.enforce_auth_role_separation() IS
  'P4.2 trigger-only guard preventing one Auth user from holding client/admin, operator and convoyeur identities.';

DROP TRIGGER IF EXISTS trg_enforce_auth_role_separation_clients ON public.clients;
CREATE TRIGGER trg_enforce_auth_role_separation_clients
  BEFORE INSERT OR UPDATE OF auth_user_id, role ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_auth_role_separation();

DROP TRIGGER IF EXISTS trg_enforce_auth_role_separation_convoyeurs ON public.convoyeurs;
CREATE TRIGGER trg_enforce_auth_role_separation_convoyeurs
  BEFORE INSERT OR UPDATE OF auth_user_id ON public.convoyeurs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_auth_role_separation();

DROP TRIGGER IF EXISTS trg_enforce_auth_role_separation_internal_operators ON public.internal_operators;
CREATE TRIGGER trg_enforce_auth_role_separation_internal_operators
  BEFORE INSERT OR UPDATE OF user_id, active ON public.internal_operators
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_auth_role_separation();

DROP TRIGGER IF EXISTS trg_enforce_auth_role_separation_user_roles ON public.user_roles;
CREATE TRIGGER trg_enforce_auth_role_separation_user_roles
  BEFORE INSERT OR UPDATE OF user_id, role ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_auth_role_separation();

COMMIT;
