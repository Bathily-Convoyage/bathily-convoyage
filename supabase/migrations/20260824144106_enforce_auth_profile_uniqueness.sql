BEGIN;

-- Keep the duplicate preflight and index creation atomic. The tables are
-- currently small, so a brief write lock is safer than allowing a new duplicate
-- to race the checks during a future deployment.
LOCK TABLE public.clients, public.convoyeurs IN SHARE ROW EXCLUSIVE MODE;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.clients
    WHERE auth_user_id IS NOT NULL
    GROUP BY auth_user_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce clients.auth_user_id uniqueness: duplicate non-null values exist'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.convoyeurs
    WHERE auth_user_id IS NOT NULL
    GROUP BY auth_user_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce convoyeurs.auth_user_id uniqueness: duplicate non-null values exist'
      USING ERRCODE = '23505';
  END IF;
END
$migration$;

-- Partial unique indexes preserve the existing nullable onboarding flows while
-- guaranteeing at most one profile per authenticated user inside each table.
CREATE UNIQUE INDEX uq_clients_auth_user_id_not_null
  ON public.clients (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE UNIQUE INDEX uq_convoyeurs_auth_user_id_not_null
  ON public.convoyeurs (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

COMMIT;
