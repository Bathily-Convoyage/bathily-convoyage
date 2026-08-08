


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."admin_delete_user"("target_id" "uuid", "target_table" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF target_table = 'clients' THEN
    -- Dissocier les missions
    UPDATE public.missions SET client_id = NULL WHERE client_id = target_id;
    -- Supprimer les tickets
    DELETE FROM public.support_tickets WHERE client_id = target_id;
    -- Supprimer le client
    DELETE FROM public.clients WHERE id = target_id;
  ELSIF target_table = 'convoyeurs' THEN
    -- Récupérer le nom complet du convoyeur pour les anciennes candidatures
    DECLARE
      nom_complet text;
    BEGIN
      SELECT (prenom || ' ' || nom) INTO nom_complet
      FROM public.convoyeurs WHERE id = target_id;

      -- Dissocier les missions via convoyeur_id
      UPDATE public.missions
        SET convoyeur_nom = NULL, convoyeur_id = NULL, status = 'available'
        WHERE convoyeur_id = target_id;

      -- Supprimer les candidatures par convoyeur_id (nouvelles) ET par nom (anciennes)
      DELETE FROM public.candidatures WHERE convoyeur_id = target_id;
      DELETE FROM public.candidatures WHERE convoyeur_nom = nom_complet;

      -- Supprimer le convoyeur
      DELETE FROM public.convoyeurs WHERE id = target_id;
    END;
  ELSE
    RAISE EXCEPTION 'Table non supportée : %', target_table;
  END IF;
END;
$$;


ALTER FUNCTION "public"."admin_delete_user"("target_id" "uuid", "target_table" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_toggle_ban"("target_id" "uuid", "target_table" "text", "ban_status" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- strict admin check
  if not exists (
    select 1
    from public.clients c
    where c.auth_user_id = auth.uid()
      and c.role = 'admin'
  ) then
    raise exception 'not authorized';
  end if;

  if target_table = 'clients' then
    update public.clients
    set banned = ban_status
    where id = target_id;

  elsif target_table = 'convoyeurs' then
    update public.convoyeurs
    set banned = ban_status
    where id = target_id;

  else
    raise exception 'invalid target_table';
  end if;
end;
$$;


ALTER FUNCTION "public"."admin_toggle_ban"("target_id" "uuid", "target_table" "text", "ban_status" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_parrainage_code"("code_input" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  _row public.parrainages%ROWTYPE;
BEGIN
  SELECT * INTO _row
  FROM public.parrainages
  WHERE code_parrain = code_input AND statut = 'en_attente'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.parrainages
  SET filleul_id = auth.uid(),
      filleul_email = (auth.jwt() ->> 'email'),
      statut = 'complete'
  WHERE id = _row.id;

  RETURN true;
END;
$$;


ALTER FUNCTION "public"."apply_parrainage_code"("code_input" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_link_missions_to_client"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.missions
  SET client_id = NEW.id
  WHERE client_email = NEW.email
    AND client_id IS NULL;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."auto_link_missions_to_client"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Mise à jour table clients si email correspond
  UPDATE public.clients
  SET auth_user_id = NEW.id
  WHERE email = NEW.email
    AND auth_user_id IS NULL;

  -- Mise à jour table convoyeurs si email correspond
  UPDATE public.convoyeurs
  SET auth_user_id = NEW.id
  WHERE email = NEW.email
    AND auth_user_id IS NULL;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_auth_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.clients c
    WHERE c.role = 'admin'
      AND c.auth_user_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin_by_email"("user_email" "text") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM clients
    WHERE email = user_email
      AND role = 'admin'
  );
$$;


ALTER FUNCTION "public"."is_admin_by_email"("user_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."like_reseau_post"("post_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.reseau_posts
  SET likes_count = COALESCE(likes_count, 0) + 1
  WHERE id = post_id;
END;
$$;


ALTER FUNCTION "public"."like_reseau_post"("post_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reseau_comments_set_author_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.author_id is null then
    new.author_id := auth.uid();
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."reseau_comments_set_author_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_avis_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_avis_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_clients_auth_user_id"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Only enforce for authenticated requests
  IF NEW.auth_user_id IS NULL AND (auth.uid() IS NOT NULL) THEN
    NEW.auth_user_id := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_clients_auth_user_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_clients_auth_user_id_on_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- If app sends NULL, force it to current user
  IF NEW.auth_user_id IS NULL AND (auth.uid() IS NOT NULL) THEN
    NEW.auth_user_id := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_clients_auth_user_id_on_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_newsletter_unsubscribe_token"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.unsubscribe_token IS NULL OR NEW.unsubscribe_token = '' THEN
    NEW.unsubscribe_token := gen_random_uuid()::text;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_newsletter_unsubscribe_token"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unsubscribe_newsletter_by_token"("token_input" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.newsletter_subscribers
  SET statut = 'desinscrit', updated_at = now()
  WHERE unsubscribe_token = token_input;

  RETURN FOUND;
END;
$$;


ALTER FUNCTION "public"."unsubscribe_newsletter_by_token"("token_input" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."avis" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "auteur_type" "text" NOT NULL,
    "auteur_nom" "text" NOT NULL,
    "auteur_email" "text",
    "user_id" "uuid",
    "note" integer NOT NULL,
    "titre" "text",
    "commentaire" "text" NOT NULL,
    "mission_id" "uuid",
    "ville" "text",
    "type_service" "text",
    "statut" "text" DEFAULT 'en_attente'::"text" NOT NULL,
    "reponse_admin" "text",
    "source" "text" DEFAULT 'site'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "approved_at" timestamp with time zone,
    CONSTRAINT "avis_auteur_type_check" CHECK (("auteur_type" = ANY (ARRAY['client'::"text", 'convoyeur'::"text", 'visiteur'::"text"]))),
    CONSTRAINT "avis_note_check" CHECK ((("note" >= 1) AND ("note" <= 5))),
    CONSTRAINT "avis_statut_check" CHECK (("statut" = ANY (ARRAY['en_attente'::"text", 'approuve'::"text", 'rejete'::"text"])))
);


ALTER TABLE "public"."avis" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."badges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "nom" "text" NOT NULL,
    "description" "text" NOT NULL,
    "icon" "text" DEFAULT 'fa-medal'::"text" NOT NULL,
    "couleur" "text" DEFAULT '#0A4D68'::"text" NOT NULL,
    "condition" "text" NOT NULL,
    "points" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."badges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campagnes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sujet" "text" NOT NULL,
    "contenu" "text" NOT NULL,
    "statut" "text" DEFAULT 'brouillon'::"text" NOT NULL,
    "destinataires" integer DEFAULT 0 NOT NULL,
    "envoyee_le" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "campagnes_statut_check" CHECK (("statut" = ANY (ARRAY['brouillon'::"text", 'envoyee'::"text", 'planifiee'::"text"])))
);


ALTER TABLE "public"."campagnes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."candidatures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "mission_id" "uuid" NOT NULL,
    "convoyeur_nom" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text",
    "convoyeur_id" "uuid",
    "mission_reference" "text",
    "mission_trajet" "text",
    "mission_montant" numeric
);


ALTER TABLE "public"."candidatures" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "email" "text" NOT NULL,
    "nom" "text" NOT NULL,
    "prenom" "text" NOT NULL,
    "telephone" "text",
    "societe" "text",
    "documents" "jsonb" DEFAULT '{}'::"jsonb",
    "adresse" "text",
    "code_postal" "text",
    "ville" "text",
    "pays" "text" DEFAULT 'France'::"text",
    "entreprise" "text",
    "siret" "text",
    "role" "text" DEFAULT 'client'::"text",
    "tva_intra" "text",
    "notes_admin" "text",
    "auth_user_id" "uuid",
    "banned" boolean DEFAULT false,
    "is_pro" boolean DEFAULT false,
    "pro_status" "text",
    "notes" "text"
);


ALTER TABLE "public"."clients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."convoyeur_badges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "badge_id" "uuid" NOT NULL,
    "mission_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."convoyeur_badges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."convoyeur_candidatures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "prenom" "text" NOT NULL,
    "nom" "text" NOT NULL,
    "email" "text" NOT NULL,
    "telephone" "text",
    "date_naissance" "date",
    "ville" "text",
    "mot_de_passe" "text",
    "type_permis" "text",
    "annee_permis" integer,
    "experience" "text",
    "score_quiz" integer,
    "reponses_quiz" "jsonb",
    "quiz_attempts" integer DEFAULT 0,
    "last_attempt_at" timestamp with time zone,
    "statut" "text" DEFAULT 'pending'::"text",
    "notes_admin" "text",
    "documents" "jsonb" DEFAULT '{}'::"jsonb",
    "deleted_at" timestamp with time zone,
    "banned" boolean DEFAULT false,
    "zone" "text",
    "adresse" "text",
    "code_postal" "text",
    "selfie" "text",
    "video_presentation" "text",
    "existing_auth_user_id" "uuid",
    CONSTRAINT "convoyeur_candidatures_statut_check" CHECK (("statut" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."convoyeur_candidatures" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."convoyeurs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "nom" "text" NOT NULL,
    "prenom" "text" NOT NULL,
    "email" "text",
    "telephone" "text",
    "taux_auto" numeric DEFAULT 0.47,
    "taux_moto" numeric DEFAULT 0.40,
    "zone" "text" DEFAULT 'Nationale'::"text",
    "niveau" "text" DEFAULT 'Standard'::"text",
    "note_interne" "text",
    "disponible" boolean DEFAULT true,
    "siret" "text",
    "iban" "text",
    "documents" "jsonb" DEFAULT '{}'::"jsonb",
    "adresse" "text",
    "code_postal" "text",
    "ville" "text",
    "pays" "text" DEFAULT 'France'::"text",
    "zones" "jsonb" DEFAULT '[]'::"jsonb",
    "note_moyenne" numeric(2,1) DEFAULT 5.0,
    "grade" "text" DEFAULT 'Standard'::"text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "statut" "text" DEFAULT 'disponible'::"text",
    "type_permis" "text",
    "nombre_missions" integer DEFAULT 0,
    "auth_user_id" "uuid",
    "banned" boolean DEFAULT false,
    "annee_permis" integer,
    "notes_admin" "text",
    "selfie" "text",
    "video_presentation" "text"
);


ALTER TABLE "public"."convoyeurs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."convoyeurs_public" WITH ("security_invoker"='true') AS
 SELECT "id",
    "prenom",
    "ville",
    "zone",
    "niveau",
    "disponible",
    "zones",
    "note_moyenne",
    "grade",
    "taux_auto",
    "taux_moto",
    "auth_user_id"
   FROM "public"."convoyeurs";


ALTER VIEW "public"."convoyeurs_public" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."devis" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reference" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "client_nom" "text",
    "client_prenom" "text",
    "client_email" "text",
    "depart" "text",
    "arrivee" "text",
    "vehicule" "text",
    "total_ht" numeric,
    "status" "text" DEFAULT 'pending'::"text",
    "details" "jsonb",
    "mode" "text" DEFAULT 'route'::"text",
    "relance_envoyee" timestamp with time zone,
    "vehicle_condition" "text" DEFAULT 'working'::"text",
    "utilitaire_size" "text",
    "is_collection" boolean DEFAULT false,
    "client_id" "uuid",
    "pack" "text",
    "date_depart" "date",
    "date_livraison" "date",
    "heure_livraison" time without time zone,
    CONSTRAINT "devis_vehicle_condition_check" CHECK (("vehicle_condition" = ANY (ARRAY['working'::"text", 'non_working'::"text"])))
);


ALTER TABLE "public"."devis" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."edls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "mission_id" "uuid",
    "reference" "text" NOT NULL,
    "type" "text" NOT NULL,
    "convoyeur_nom" "text" NOT NULL,
    "permis" "text",
    "date_heure" timestamp with time zone NOT NULL,
    "kilometrage" integer,
    "niveau_carburant" integer,
    "photos" "jsonb" DEFAULT '[]'::"jsonb",
    "dommages" "jsonb" DEFAULT '[]'::"jsonb",
    "documents" "jsonb" DEFAULT '[]'::"jsonb",
    "conforme" boolean DEFAULT true,
    "signatures" "jsonb",
    "observations" "text",
    "email_client" "text",
    "equipements" "jsonb" DEFAULT '[]'::"jsonb",
    "mecanique" "jsonb" DEFAULT '[]'::"jsonb",
    "remarques_techniques" "text",
    "kilometage" "text",
    "photo_fin_mission" "text",
    "fin_mission_selfie_uploaded_at" timestamp with time zone,
    CONSTRAINT "edls_type_check" CHECK (("type" = ANY (ARRAY['depart'::"text", 'arrivee'::"text"])))
);


ALTER TABLE "public"."edls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."missions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reference" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "client_nom" "text",
    "depart" "text",
    "arrivee" "text",
    "vehicule" "text",
    "mode_transport" "text",
    "pack" "text",
    "montant_ht" numeric,
    "remuneration_convoyeur" numeric,
    "marge" numeric,
    "status" "text" DEFAULT 'planned'::"text",
    "convoyeur_nom" "text",
    "date_mission" "date",
    "paiement_statut" "text" DEFAULT 'pending'::"text",
    "stripe_session_id" "text",
    "client_email" "text",
    "client_id" "uuid",
    "convoyeur_id" "uuid",
    "mode" "text" DEFAULT 'route'::"text",
    "client_address" "text",
    "rappel_envoye" timestamp with time zone,
    "trajet" "text",
    "heure_depart" "text",
    "annee" "text",
    "carburant" "text",
    "puissance" "text",
    "type_vehicule" "text",
    "immatriculation" "text",
    "client_telephone" "text",
    "client_telephone_livraison" "text",
    "convoyeur_telephone" "text",
    "zone_convoyeur" "text",
    "notes" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "depart_ville" "text",
    "arrivee_ville" "text",
    "distance_km" integer,
    "photo_fin_mission" "text",
    "fin_mission_selfie_uploaded_at" timestamp with time zone,
    CONSTRAINT "missions_paiement_statut_check" CHECK (("paiement_statut" = ANY (ARRAY['pending'::"text", 'paid'::"text", 'paye'::"text"]))),
    CONSTRAINT "missions_status_check" CHECK (("status" = ANY (ARRAY['available'::"text", 'planned'::"text", 'in_progress'::"text", 'completed'::"text", 'cancelled'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."missions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."newsletter_subscribers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "nom" "text",
    "source" "text" DEFAULT 'homepage'::"text" NOT NULL,
    "statut" "text" DEFAULT 'actif'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "unsubscribe_token" "text",
    CONSTRAINT "newsletter_subscribers_statut_check" CHECK (("statut" = ANY (ARRAY['actif'::"text", 'desinscrit'::"text", 'bounce'::"text"])))
);


ALTER TABLE "public"."newsletter_subscribers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."parrainages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "parrain_id" "uuid" NOT NULL,
    "parrain_email" "text" NOT NULL,
    "filleul_email" "text" NOT NULL,
    "filleul_id" "uuid",
    "code_parrain" "text" NOT NULL,
    "statut" "text" DEFAULT 'en_attente'::"text" NOT NULL,
    "recompense_parrain" integer DEFAULT 10 NOT NULL,
    "recompense_filleul" integer DEFAULT 10 NOT NULL,
    "mission_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "parrainages_statut_check" CHECK (("statut" = ANY (ARRAY['en_attente'::"text", 'complete'::"text", 'paye'::"text"])))
);


ALTER TABLE "public"."parrainages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."points_fidelite" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "points" integer NOT NULL,
    "motif" "text" NOT NULL,
    "mission_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."points_fidelite" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."promo_codes" (
    "id" bigint NOT NULL,
    "code" "text" NOT NULL,
    "remise_pourcent" integer DEFAULT 10 NOT NULL,
    "texte_affiche" "text" DEFAULT 'Offre de lancement'::"text" NOT NULL,
    "date_debut" timestamp with time zone DEFAULT "now"(),
    "date_fin" timestamp with time zone,
    "actif" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."promo_codes" OWNER TO "postgres";


ALTER TABLE "public"."promo_codes" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."promo_codes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "endpoint" "text" NOT NULL,
    "p256dh" "text",
    "auth_key" "text",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reseau_comments" (
    "id" "uuid" NOT NULL,
    "post_id" "uuid",
    "author_name" "text",
    "content" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "author_id" "uuid"
);


ALTER TABLE "public"."reseau_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reseau_posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "author_id" "uuid",
    "author_name" "text",
    "author_role" "text",
    "content" "text",
    "tags" "jsonb",
    "likes_count" integer DEFAULT 0,
    "is_announcement" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."reseau_posts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."solde_fidelite" WITH ("security_invoker"='true') AS
 SELECT "user_id",
    COALESCE("sum"("points"), (0)::bigint) AS "solde_points",
    "count"(*) AS "nb_transactions"
   FROM "public"."points_fidelite"
  GROUP BY "user_id";


ALTER VIEW "public"."solde_fidelite" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_tickets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "client_id" "uuid",
    "client_email" "text" NOT NULL,
    "mission_id" "uuid",
    "sujet" "text" NOT NULL,
    "message" "text" NOT NULL,
    "statut" "text" DEFAULT 'ouvert'::"text",
    "priorite" "text" DEFAULT 'normale'::"text",
    "reponse_admin" "text",
    "repondu_at" timestamp with time zone,
    "convoyeur_id" "uuid",
    "convoyeur_email" "text",
    "convoyeur_nom" "text",
    "client_nom" "text",
    "reponse" "text",
    "status" "text" DEFAULT 'open'::"text",
    CONSTRAINT "support_tickets_priorite_check" CHECK (("priorite" = ANY (ARRAY['basse'::"text", 'normale'::"text", 'haute'::"text", 'urgente'::"text"]))),
    CONSTRAINT "support_tickets_statut_check" CHECK (("statut" = ANY (ARRAY['ouvert'::"text", 'en_cours'::"text", 'resolu'::"text", 'ferme'::"text"])))
);


ALTER TABLE "public"."support_tickets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_settings" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."system_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vehicules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "client_id" "uuid",
    "marque" "text" NOT NULL,
    "modele" "text" NOT NULL,
    "immatriculation" "text",
    "annee" integer,
    "carburant" "text",
    "couleur" "text",
    "notes" "text",
    "type_vehicule" "text" DEFAULT 'Automobile'::"text",
    "vin" "text",
    "date_premiere_circulation" "date",
    "numero_carte_grise" "text"
);


ALTER TABLE "public"."vehicules" OWNER TO "postgres";


ALTER TABLE ONLY "public"."avis"
    ADD CONSTRAINT "avis_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."badges"
    ADD CONSTRAINT "badges_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."badges"
    ADD CONSTRAINT "badges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campagnes"
    ADD CONSTRAINT "campagnes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."candidatures"
    ADD CONSTRAINT "candidatures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."convoyeur_badges"
    ADD CONSTRAINT "convoyeur_badges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."convoyeur_badges"
    ADD CONSTRAINT "convoyeur_badges_user_id_badge_id_key" UNIQUE ("user_id", "badge_id");



ALTER TABLE ONLY "public"."convoyeur_candidatures"
    ADD CONSTRAINT "convoyeur_candidatures_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."convoyeur_candidatures"
    ADD CONSTRAINT "convoyeur_candidatures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."convoyeurs"
    ADD CONSTRAINT "convoyeurs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."devis"
    ADD CONSTRAINT "devis_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."devis"
    ADD CONSTRAINT "devis_reference_key" UNIQUE ("reference");



ALTER TABLE ONLY "public"."edls"
    ADD CONSTRAINT "edls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edls"
    ADD CONSTRAINT "edls_reference_key" UNIQUE ("reference");



ALTER TABLE ONLY "public"."missions"
    ADD CONSTRAINT "missions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."missions"
    ADD CONSTRAINT "missions_reference_key" UNIQUE ("reference");



ALTER TABLE ONLY "public"."newsletter_subscribers"
    ADD CONSTRAINT "newsletter_subscribers_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."newsletter_subscribers"
    ADD CONSTRAINT "newsletter_subscribers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."parrainages"
    ADD CONSTRAINT "parrainages_code_parrain_key" UNIQUE ("code_parrain");



ALTER TABLE ONLY "public"."parrainages"
    ADD CONSTRAINT "parrainages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."points_fidelite"
    ADD CONSTRAINT "points_fidelite_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."promo_codes"
    ADD CONSTRAINT "promo_codes_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."promo_codes"
    ADD CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_endpoint_key" UNIQUE ("user_id", "endpoint");



ALTER TABLE ONLY "public"."reseau_comments"
    ADD CONSTRAINT "reseau_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reseau_posts"
    ADD CONSTRAINT "reseau_posts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_settings"
    ADD CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."vehicules"
    ADD CONSTRAINT "vehicules_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_avis_created" ON "public"."avis" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_avis_mission_id" ON "public"."avis" USING "btree" ("mission_id");



CREATE INDEX "idx_avis_note" ON "public"."avis" USING "btree" ("note");



CREATE INDEX "idx_avis_statut" ON "public"."avis" USING "btree" ("statut");



CREATE INDEX "idx_avis_user_id" ON "public"."avis" USING "btree" ("user_id");



CREATE INDEX "idx_campagnes_created_by" ON "public"."campagnes" USING "btree" ("created_by");



CREATE INDEX "idx_candidatures_convoyeur_id" ON "public"."candidatures" USING "btree" ("convoyeur_id");



CREATE INDEX "idx_candidatures_mission_id" ON "public"."candidatures" USING "btree" ("mission_id");



CREATE INDEX "idx_clients_auth_user_id" ON "public"."clients" USING "btree" ("auth_user_id");



CREATE INDEX "idx_clients_email" ON "public"."clients" USING "btree" ("email");



CREATE INDEX "idx_clients_pro_status" ON "public"."clients" USING "btree" ("pro_status") WHERE ("pro_status" IS NOT NULL);



CREATE INDEX "idx_conv_badges_user" ON "public"."convoyeur_badges" USING "btree" ("user_id");



CREATE INDEX "idx_convoyeur_badges_badge_id" ON "public"."convoyeur_badges" USING "btree" ("badge_id");



CREATE INDEX "idx_convoyeur_badges_mission_id" ON "public"."convoyeur_badges" USING "btree" ("mission_id");



CREATE INDEX "idx_convoyeur_candidatures_email" ON "public"."convoyeur_candidatures" USING "btree" ("email");



CREATE INDEX "idx_convoyeur_candidatures_statut" ON "public"."convoyeur_candidatures" USING "btree" ("statut");



CREATE INDEX "idx_convoyeurs_auth_user_id" ON "public"."convoyeurs" USING "btree" ("auth_user_id");



CREATE INDEX "idx_convoyeurs_email" ON "public"."convoyeurs" USING "btree" ("email");



CREATE INDEX "idx_devis_relance" ON "public"."devis" USING "btree" ("status", "created_at") WHERE ("relance_envoyee" IS NULL);



CREATE INDEX "idx_devis_vehicle_condition" ON "public"."devis" USING "btree" ("vehicle_condition") WHERE ("vehicle_condition" IS NOT NULL);



CREATE INDEX "idx_edls_mission_id" ON "public"."edls" USING "btree" ("mission_id");



CREATE INDEX "idx_missions_client_email" ON "public"."missions" USING "btree" ("client_email");



CREATE INDEX "idx_missions_client_id" ON "public"."missions" USING "btree" ("client_id");



CREATE INDEX "idx_missions_convoyeur_id" ON "public"."missions" USING "btree" ("convoyeur_id");



CREATE INDEX "idx_missions_rappel" ON "public"."missions" USING "btree" ("status", "date_mission") WHERE ("rappel_envoye" IS NULL);



CREATE INDEX "idx_missions_status" ON "public"."missions" USING "btree" ("status");



CREATE INDEX "idx_newsletter_email" ON "public"."newsletter_subscribers" USING "btree" ("email");



CREATE INDEX "idx_newsletter_statut" ON "public"."newsletter_subscribers" USING "btree" ("statut");



CREATE UNIQUE INDEX "idx_newsletter_unsubscribe_token" ON "public"."newsletter_subscribers" USING "btree" ("unsubscribe_token");



CREATE INDEX "idx_parrainages_code" ON "public"."parrainages" USING "btree" ("code_parrain");



CREATE INDEX "idx_parrainages_filleul_id" ON "public"."parrainages" USING "btree" ("filleul_id");



CREATE INDEX "idx_parrainages_mission_id" ON "public"."parrainages" USING "btree" ("mission_id");



CREATE INDEX "idx_parrainages_parrain" ON "public"."parrainages" USING "btree" ("parrain_id");



CREATE INDEX "idx_parrainages_statut" ON "public"."parrainages" USING "btree" ("statut");



CREATE INDEX "idx_points_fidelite_mission_id" ON "public"."points_fidelite" USING "btree" ("mission_id");



CREATE INDEX "idx_points_user" ON "public"."points_fidelite" USING "btree" ("user_id");



CREATE INDEX "idx_push_user" ON "public"."push_subscriptions" USING "btree" ("user_id");



CREATE INDEX "idx_reseau_comments_post_id" ON "public"."reseau_comments" USING "btree" ("post_id");



CREATE INDEX "idx_support_tickets_convoyeur_id" ON "public"."support_tickets" USING "btree" ("convoyeur_id");



CREATE INDEX "idx_support_tickets_mission_id" ON "public"."support_tickets" USING "btree" ("mission_id");



CREATE INDEX "idx_tickets_client_id" ON "public"."support_tickets" USING "btree" ("client_id");



CREATE INDEX "idx_tickets_statut" ON "public"."support_tickets" USING "btree" ("statut");



CREATE INDEX "idx_vehicules_client_id" ON "public"."vehicules" USING "btree" ("client_id");



CREATE OR REPLACE TRIGGER "set_newsletter_token" BEFORE INSERT ON "public"."newsletter_subscribers" FOR EACH ROW EXECUTE FUNCTION "public"."set_newsletter_unsubscribe_token"();



CREATE OR REPLACE TRIGGER "trg_auto_link_missions" AFTER INSERT ON "public"."clients" FOR EACH ROW EXECUTE FUNCTION "public"."auto_link_missions_to_client"();



CREATE OR REPLACE TRIGGER "trg_avis_updated" BEFORE UPDATE ON "public"."avis" FOR EACH ROW EXECUTE FUNCTION "public"."set_avis_updated_at"();



CREATE OR REPLACE TRIGGER "trg_missions_updated_at" BEFORE UPDATE ON "public"."missions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_reseau_comments_set_author_id" BEFORE INSERT ON "public"."reseau_comments" FOR EACH ROW EXECUTE FUNCTION "public"."reseau_comments_set_author_id"();



CREATE OR REPLACE TRIGGER "trg_set_clients_auth_user_id" BEFORE INSERT ON "public"."clients" FOR EACH ROW EXECUTE FUNCTION "public"."set_clients_auth_user_id"();



CREATE OR REPLACE TRIGGER "trg_set_clients_auth_user_id_on_update" BEFORE UPDATE ON "public"."clients" FOR EACH ROW EXECUTE FUNCTION "public"."set_clients_auth_user_id_on_update"();



ALTER TABLE ONLY "public"."avis"
    ADD CONSTRAINT "avis_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."avis"
    ADD CONSTRAINT "avis_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."campagnes"
    ADD CONSTRAINT "campagnes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."candidatures"
    ADD CONSTRAINT "candidatures_convoyeur_id_fkey" FOREIGN KEY ("convoyeur_id") REFERENCES "public"."convoyeurs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."candidatures"
    ADD CONSTRAINT "candidatures_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."convoyeur_badges"
    ADD CONSTRAINT "convoyeur_badges_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."convoyeur_badges"
    ADD CONSTRAINT "convoyeur_badges_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."convoyeur_badges"
    ADD CONSTRAINT "convoyeur_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."convoyeur_candidatures"
    ADD CONSTRAINT "convoyeur_candidatures_existing_auth_user_id_fkey" FOREIGN KEY ("existing_auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."convoyeurs"
    ADD CONSTRAINT "convoyeurs_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."edls"
    ADD CONSTRAINT "edls_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."missions"
    ADD CONSTRAINT "missions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."missions"
    ADD CONSTRAINT "missions_convoyeur_id_fkey" FOREIGN KEY ("convoyeur_id") REFERENCES "public"."convoyeurs"("id");



ALTER TABLE ONLY "public"."parrainages"
    ADD CONSTRAINT "parrainages_filleul_id_fkey" FOREIGN KEY ("filleul_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."parrainages"
    ADD CONSTRAINT "parrainages_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."parrainages"
    ADD CONSTRAINT "parrainages_parrain_id_fkey" FOREIGN KEY ("parrain_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."points_fidelite"
    ADD CONSTRAINT "points_fidelite_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."points_fidelite"
    ADD CONSTRAINT "points_fidelite_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reseau_comments"
    ADD CONSTRAINT "reseau_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."reseau_posts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_convoyeur_id_fkey" FOREIGN KEY ("convoyeur_id") REFERENCES "public"."convoyeurs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vehicules"
    ADD CONSTRAINT "vehicules_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE "public"."avis" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "avis_insert_anon_safe" ON "public"."avis" FOR INSERT TO "anon" WITH CHECK ((("user_id" IS NULL) AND ("auteur_email" IS NOT NULL)));



CREATE POLICY "avis_insert_auth_safe" ON "public"."avis" FOR INSERT TO "authenticated" WITH CHECK (((("user_id" IS NULL) OR ("user_id" = "auth"."uid"())) AND ("auteur_email" IS NOT NULL)));



CREATE POLICY "avis_select_admin" ON "public"."avis" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "avis_select_approved" ON "public"."avis" FOR SELECT TO "authenticated", "anon" USING (("statut" = 'approuve'::"text"));



CREATE POLICY "avis_update_own" ON "public"."avis" FOR UPDATE TO "authenticated" USING ((("user_id" = "auth"."uid"()) AND ("statut" = 'en_attente'::"text"))) WITH CHECK ((("user_id" = "auth"."uid"()) AND ("statut" = 'en_attente'::"text")));



ALTER TABLE "public"."badges" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "badges_delete_admin" ON "public"."badges" FOR DELETE TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "badges_insert_admin" ON "public"."badges" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_admin"());



CREATE POLICY "badges_select_public" ON "public"."badges" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "badges_update_admin" ON "public"."badges" FOR UPDATE TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."campagnes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "campagnes_admin_all" ON "public"."campagnes" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."candidatures" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "candidatures_conv_delete_admin" ON "public"."convoyeur_candidatures" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "candidatures_conv_select_admin" ON "public"."convoyeur_candidatures" FOR SELECT USING ("public"."is_admin"());



CREATE POLICY "candidatures_conv_select_own" ON "public"."convoyeur_candidatures" FOR SELECT TO "authenticated" USING (("email" = ("auth"."jwt"() ->> 'email'::"text")));



CREATE POLICY "candidatures_conv_update_admin" ON "public"."convoyeur_candidatures" FOR UPDATE USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "candidatures_delete_admin" ON "public"."candidatures" FOR DELETE USING ("public"."is_admin"());



CREATE POLICY "candidatures_delete_concerned" ON "public"."candidatures" FOR DELETE TO "authenticated" USING (("mission_id" IN ( SELECT "m"."id"
   FROM "public"."missions" "m"
  WHERE (("m"."client_id" IN ( SELECT "cl"."id"
           FROM "public"."clients" "cl"
          WHERE ("cl"."auth_user_id" = "auth"."uid"()))) OR ("m"."convoyeur_id" IN ( SELECT "cv"."id"
           FROM "public"."convoyeurs" "cv"
          WHERE ("cv"."auth_user_id" = "auth"."uid"())))))));



CREATE POLICY "candidatures_insert_authenticated" ON "public"."candidatures" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() IS NOT NULL) AND ("convoyeur_id" IN ( SELECT "convoyeurs"."id"
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"())))));



CREATE POLICY "candidatures_select_concerned" ON "public"."candidatures" FOR SELECT TO "authenticated" USING (("mission_id" IN ( SELECT "m"."id"
   FROM "public"."missions" "m"
  WHERE (("m"."client_id" IN ( SELECT "cl"."id"
           FROM "public"."clients" "cl"
          WHERE ("cl"."auth_user_id" = "auth"."uid"()))) OR ("m"."convoyeur_id" IN ( SELECT "cv"."id"
           FROM "public"."convoyeurs" "cv"
          WHERE ("cv"."auth_user_id" = "auth"."uid"())))))));



CREATE POLICY "candidatures_select_own_or_admin" ON "public"."candidatures" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("convoyeur_id" IN ( SELECT "convoyeurs"."id"
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."prenom" || ' '::"text") || "convoyeurs"."nom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."nom" || ' '::"text") || "convoyeurs"."prenom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"())))));



CREATE POLICY "candidatures_update_admin" ON "public"."candidatures" FOR UPDATE USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "candidatures_update_concerned" ON "public"."candidatures" FOR UPDATE TO "authenticated" USING (("mission_id" IN ( SELECT "m"."id"
   FROM "public"."missions" "m"
  WHERE (("m"."client_id" IN ( SELECT "cl"."id"
           FROM "public"."clients" "cl"
          WHERE ("cl"."auth_user_id" = "auth"."uid"()))) OR ("m"."convoyeur_id" IN ( SELECT "cv"."id"
           FROM "public"."convoyeurs" "cv"
          WHERE ("cv"."auth_user_id" = "auth"."uid"()))))))) WITH CHECK (("mission_id" IN ( SELECT "m"."id"
   FROM "public"."missions" "m"
  WHERE (("m"."client_id" IN ( SELECT "cl"."id"
           FROM "public"."clients" "cl"
          WHERE ("cl"."auth_user_id" = "auth"."uid"()))) OR ("m"."convoyeur_id" IN ( SELECT "cv"."id"
           FROM "public"."convoyeurs" "cv"
          WHERE ("cv"."auth_user_id" = "auth"."uid"())))))));



ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clients_delete_admin" ON "public"."clients" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c_admin"
  WHERE (("c_admin"."auth_user_id" = "auth"."uid"()) AND ("c_admin"."role" = 'admin'::"text")))));



CREATE POLICY "clients_delete_admin_rpc" ON "public"."clients" FOR DELETE TO "postgres" USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c_admin"
  WHERE (("c_admin"."auth_user_id" = "auth"."uid"()) AND ("c_admin"."role" = 'admin'::"text")))));



CREATE POLICY "clients_insert_admin" ON "public"."clients" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."clients" "c_admin"
  WHERE (("c_admin"."auth_user_id" = "auth"."uid"()) AND ("c_admin"."role" = 'admin'::"text")))));



CREATE POLICY "clients_insert_authenticated" ON "public"."clients" FOR INSERT TO "authenticated" WITH CHECK (("auth_user_id" = "auth"."uid"()));



CREATE POLICY "clients_insert_own" ON "public"."clients" FOR INSERT TO "authenticated" WITH CHECK (("auth_user_id" = "auth"."uid"()));



CREATE POLICY "clients_insert_public_safe" ON "public"."clients" FOR INSERT TO "anon" WITH CHECK ((("auth_user_id" IS NULL) AND ("role" IS DISTINCT FROM 'admin'::"text")));



CREATE POLICY "clients_select_own" ON "public"."clients" FOR SELECT TO "authenticated" USING (("auth_user_id" = "auth"."uid"()));



CREATE POLICY "clients_select_own_or_admin" ON "public"."clients" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("auth_user_id" = "auth"."uid"()) OR ("email" = ("auth"."jwt"() ->> 'email'::"text"))));



CREATE POLICY "clients_update_own_strict" ON "public"."clients" FOR UPDATE TO "authenticated" USING (("auth_user_id" = "auth"."uid"())) WITH CHECK (("auth_user_id" = "auth"."uid"()));



CREATE POLICY "conv_badges_select_own" ON "public"."convoyeur_badges" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."convoyeur_badges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."convoyeur_candidatures" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."convoyeurs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "convoyeurs_delete_admin" ON "public"."convoyeurs" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c_admin"
  WHERE (("c_admin"."auth_user_id" = "auth"."uid"()) AND ("c_admin"."role" = 'admin'::"text")))));



CREATE POLICY "convoyeurs_delete_admin_rpc" ON "public"."convoyeurs" FOR DELETE TO "postgres" USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c_admin"
  WHERE (("c_admin"."auth_user_id" = "auth"."uid"()) AND ("c_admin"."role" = 'admin'::"text")))));



CREATE POLICY "convoyeurs_insert_admin" ON "public"."convoyeurs" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."clients" "c_admin"
  WHERE (("c_admin"."auth_user_id" = "auth"."uid"()) AND ("c_admin"."role" = 'admin'::"text")))));



CREATE POLICY "convoyeurs_insert_own" ON "public"."convoyeurs" FOR INSERT TO "authenticated" WITH CHECK (("auth_user_id" = "auth"."uid"()));



CREATE POLICY "convoyeurs_insert_public_safe" ON "public"."convoyeurs" FOR INSERT TO "anon" WITH CHECK ((("auth_user_id" IS NULL) AND ("banned" IS DISTINCT FROM true)));



CREATE POLICY "convoyeurs_select_admin" ON "public"."convoyeurs" FOR SELECT TO "authenticated" USING ((("banned" = false) AND (EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text"))))));



CREATE POLICY "convoyeurs_select_own" ON "public"."convoyeurs" FOR SELECT TO "authenticated" USING ((("auth_user_id" = "auth"."uid"()) AND ("banned" = false)));



CREATE POLICY "convoyeurs_select_own_or_admin" ON "public"."convoyeurs" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("auth_user_id" = "auth"."uid"()) OR ("email" = ("auth"."jwt"() ->> 'email'::"text"))));



CREATE POLICY "convoyeurs_update_own" ON "public"."convoyeurs" FOR UPDATE TO "authenticated" USING (("auth_user_id" = "auth"."uid"())) WITH CHECK (("auth_user_id" = "auth"."uid"()));



ALTER TABLE "public"."devis" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "devis_delete_admin" ON "public"."devis" FOR DELETE TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "devis_insert_public_safe" ON "public"."devis" FOR INSERT TO "anon" WITH CHECK ((("client_id" IS NULL) AND ("client_email" IS NOT NULL)));



CREATE POLICY "devis_select_admin_or_own" ON "public"."devis" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("client_email" = ("auth"."jwt"() ->> 'email'::"text"))));



CREATE POLICY "devis_select_own_or_admin" ON "public"."devis" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR ("client_email" = ("auth"."jwt"() ->> 'email'::"text"))));



CREATE POLICY "devis_update_admin" ON "public"."devis" FOR UPDATE TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."edls" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "edls_delete_admin" ON "public"."edls" FOR DELETE TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "edls_delete_concerned" ON "public"."edls" FOR DELETE TO "authenticated" USING (("mission_id" IN ( SELECT "m"."id"
   FROM "public"."missions" "m"
  WHERE (("m"."client_id" IN ( SELECT "cl"."id"
           FROM "public"."clients" "cl"
          WHERE ("cl"."auth_user_id" = "auth"."uid"()))) OR ("m"."convoyeur_id" IN ( SELECT "cv"."id"
           FROM "public"."convoyeurs" "cv"
          WHERE ("cv"."auth_user_id" = "auth"."uid"())))))));



CREATE POLICY "edls_insert_authenticated" ON "public"."edls" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() IS NOT NULL));



CREATE POLICY "edls_insert_concerned" ON "public"."edls" FOR INSERT TO "authenticated" WITH CHECK (("mission_id" IN ( SELECT "m"."id"
   FROM "public"."missions" "m"
  WHERE (("m"."client_id" IN ( SELECT "cl"."id"
           FROM "public"."clients" "cl"
          WHERE ("cl"."auth_user_id" = "auth"."uid"()))) OR ("m"."convoyeur_id" IN ( SELECT "cv"."id"
           FROM "public"."convoyeurs" "cv"
          WHERE ("cv"."auth_user_id" = "auth"."uid"())))))));



CREATE POLICY "edls_select_concerned" ON "public"."edls" FOR SELECT TO "authenticated" USING (("mission_id" IN ( SELECT "m"."id"
   FROM "public"."missions" "m"
  WHERE (("m"."client_id" IN ( SELECT "cl"."id"
           FROM "public"."clients" "cl"
          WHERE ("cl"."auth_user_id" = "auth"."uid"()))) OR ("m"."convoyeur_id" IN ( SELECT "cv"."id"
           FROM "public"."convoyeurs" "cv"
          WHERE ("cv"."auth_user_id" = "auth"."uid"())))))));



CREATE POLICY "edls_select_own_or_admin" ON "public"."edls" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR (("auth"."uid"() IS NOT NULL) AND (("mission_id" IN ( SELECT "m"."id"
   FROM ("public"."missions" "m"
     JOIN "public"."clients" "c" ON (("m"."client_id" = "c"."id")))
  WHERE (("c"."auth_user_id" = "auth"."uid"()) OR ("c"."email" = ("auth"."jwt"() ->> 'email'::"text"))))) OR ("mission_id" IN ( SELECT "m"."id"
   FROM "public"."missions" "m"
  WHERE ("m"."client_email" = ("auth"."jwt"() ->> 'email'::"text")))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."prenom" || ' '::"text") || "convoyeurs"."nom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."nom" || ' '::"text") || "convoyeurs"."prenom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"())))))));



CREATE POLICY "edls_update_concerned" ON "public"."edls" FOR UPDATE TO "authenticated" USING (("mission_id" IN ( SELECT "m"."id"
   FROM "public"."missions" "m"
  WHERE (("m"."client_id" IN ( SELECT "cl"."id"
           FROM "public"."clients" "cl"
          WHERE ("cl"."auth_user_id" = "auth"."uid"()))) OR ("m"."convoyeur_id" IN ( SELECT "cv"."id"
           FROM "public"."convoyeurs" "cv"
          WHERE ("cv"."auth_user_id" = "auth"."uid"()))))))) WITH CHECK (("mission_id" IN ( SELECT "m"."id"
   FROM "public"."missions" "m"
  WHERE (("m"."client_id" IN ( SELECT "cl"."id"
           FROM "public"."clients" "cl"
          WHERE ("cl"."auth_user_id" = "auth"."uid"()))) OR ("m"."convoyeur_id" IN ( SELECT "cv"."id"
           FROM "public"."convoyeurs" "cv"
          WHERE ("cv"."auth_user_id" = "auth"."uid"())))))));



CREATE POLICY "edls_update_own_or_admin" ON "public"."edls" FOR UPDATE TO "authenticated" USING (("public"."is_admin"() OR (("auth"."uid"() IS NOT NULL) AND (("convoyeur_nom" IN ( SELECT (("convoyeurs"."prenom" || ' '::"text") || "convoyeurs"."nom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."nom" || ' '::"text") || "convoyeurs"."prenom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))))))) WITH CHECK (("public"."is_admin"() OR (("auth"."uid"() IS NOT NULL) AND (("convoyeur_nom" IN ( SELECT (("convoyeurs"."prenom" || ' '::"text") || "convoyeurs"."nom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."nom" || ' '::"text") || "convoyeurs"."prenom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"())))))));



ALTER TABLE "public"."missions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "missions_delete_admin" ON "public"."missions" FOR DELETE TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "missions_insert_admin" ON "public"."missions" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_admin"());



CREATE POLICY "missions_select_concerned" ON "public"."missions" FOR SELECT TO "authenticated" USING ((("client_id" IN ( SELECT "cl"."id"
   FROM "public"."clients" "cl"
  WHERE ("cl"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_id" IN ( SELECT "cv"."id"
   FROM "public"."convoyeurs" "cv"
  WHERE ("cv"."auth_user_id" = "auth"."uid"())))));



CREATE POLICY "missions_select_own_or_admin" ON "public"."missions" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR (("auth"."uid"() IS NOT NULL) AND (("client_id" IN ( SELECT "clients"."id"
   FROM "public"."clients"
  WHERE (("clients"."auth_user_id" = "auth"."uid"()) OR ("clients"."email" = ("auth"."jwt"() ->> 'email'::"text"))))) OR ("client_email" = ("auth"."jwt"() ->> 'email'::"text")) OR ("convoyeur_id" IN ( SELECT "convoyeurs"."id"
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."prenom" || ' '::"text") || "convoyeurs"."nom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."nom" || ' '::"text") || "convoyeurs"."prenom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("status" = 'available'::"text")))));



CREATE POLICY "missions_select_tracking_anon" ON "public"."missions" FOR SELECT TO "anon" USING ((("auth"."uid"() IS NULL) AND ("status" = 'in_progress'::"text")));



CREATE POLICY "missions_update_admin" ON "public"."missions" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text")))));



CREATE POLICY "missions_update_own_or_admin" ON "public"."missions" FOR UPDATE TO "authenticated" USING (("public"."is_admin"() OR (("auth"."uid"() IS NOT NULL) AND (("client_id" IN ( SELECT "clients"."id"
   FROM "public"."clients"
  WHERE (("clients"."auth_user_id" = "auth"."uid"()) OR ("clients"."email" = ("auth"."jwt"() ->> 'email'::"text"))))) OR ("client_email" = ("auth"."jwt"() ->> 'email'::"text")) OR ("convoyeur_id" IN ( SELECT "convoyeurs"."id"
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."prenom" || ' '::"text") || "convoyeurs"."nom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."nom" || ' '::"text") || "convoyeurs"."prenom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))))))) WITH CHECK (("public"."is_admin"() OR (("auth"."uid"() IS NOT NULL) AND (("client_id" IN ( SELECT "clients"."id"
   FROM "public"."clients"
  WHERE (("clients"."auth_user_id" = "auth"."uid"()) OR ("clients"."email" = ("auth"."jwt"() ->> 'email'::"text"))))) OR ("client_email" = ("auth"."jwt"() ->> 'email'::"text")) OR ("convoyeur_id" IN ( SELECT "convoyeurs"."id"
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."prenom" || ' '::"text") || "convoyeurs"."nom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_nom" IN ( SELECT (("convoyeurs"."nom" || ' '::"text") || "convoyeurs"."prenom")
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"())))))));



CREATE POLICY "newsletter_insert_public_safe" ON "public"."newsletter_subscribers" FOR INSERT TO "authenticated", "anon" WITH CHECK (("email" IS NOT NULL));



CREATE POLICY "newsletter_select_admin" ON "public"."newsletter_subscribers" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."newsletter_subscribers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "newsletter_update_admin" ON "public"."newsletter_subscribers" FOR UPDATE TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "newsletter_update_own" ON "public"."newsletter_subscribers" FOR UPDATE TO "authenticated" USING (("email" = ("auth"."jwt"() ->> 'email'::"text"))) WITH CHECK (("email" = ("auth"."jwt"() ->> 'email'::"text")));



ALTER TABLE "public"."parrainages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "parrainages_insert_own" ON "public"."parrainages" FOR INSERT TO "authenticated" WITH CHECK (("parrain_id" = "auth"."uid"()));



CREATE POLICY "parrainages_select_own" ON "public"."parrainages" FOR SELECT TO "authenticated" USING ((("parrain_id" = "auth"."uid"()) OR ("filleul_id" = "auth"."uid"())));



CREATE POLICY "parrainages_update_own" ON "public"."parrainages" FOR UPDATE TO "authenticated" USING (("parrain_id" = "auth"."uid"())) WITH CHECK (("parrain_id" = "auth"."uid"()));



ALTER TABLE "public"."points_fidelite" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "points_insert_own" ON "public"."points_fidelite" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "points_select_own" ON "public"."points_fidelite" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."promo_codes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "promo_codes_admin_all" ON "public"."promo_codes" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "promo_codes_public_read" ON "public"."promo_codes" FOR SELECT TO "authenticated", "anon" USING ((("actif" = true) AND (("date_fin" IS NULL) OR ("date_fin" > "now"()))));



CREATE POLICY "push_delete_own" ON "public"."push_subscriptions" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "push_insert_own" ON "public"."push_subscriptions" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "push_select_own" ON "public"."push_subscriptions" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reseau_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reseau_comments_delete_admin" ON "public"."reseau_comments" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text")))));



CREATE POLICY "reseau_comments_insert_admin_or_convoyeur" ON "public"."reseau_comments" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text")))) OR (EXISTS ( SELECT 1
   FROM "public"."convoyeurs" "v"
  WHERE (("v"."auth_user_id" = "auth"."uid"()) AND ("v"."banned" = false))))));



CREATE POLICY "reseau_comments_select_admin_or_convoyeur" ON "public"."reseau_comments" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text")))) OR (EXISTS ( SELECT 1
   FROM "public"."convoyeurs" "v"
  WHERE (("v"."auth_user_id" = "auth"."uid"()) AND ("v"."banned" = false))))));



ALTER TABLE "public"."reseau_posts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reseau_posts_delete_admin" ON "public"."reseau_posts" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text")))));



CREATE POLICY "reseau_posts_insert_admin_or_convoyeur" ON "public"."reseau_posts" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text")))) OR (EXISTS ( SELECT 1
   FROM "public"."convoyeurs" "v"
  WHERE (("v"."auth_user_id" = "auth"."uid"()) AND ("v"."banned" = false))))));



CREATE POLICY "reseau_posts_select_admin_or_convoyeur" ON "public"."reseau_posts" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text")))) OR (EXISTS ( SELECT 1
   FROM "public"."convoyeurs" "v"
  WHERE (("v"."auth_user_id" = "auth"."uid"()) AND ("v"."banned" = false))))));



ALTER TABLE "public"."support_tickets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "support_tickets_delete_concerned" ON "public"."support_tickets" FOR DELETE TO "authenticated" USING (("client_id" IN ( SELECT "c"."id"
   FROM "public"."clients" "c"
  WHERE ("c"."auth_user_id" = "auth"."uid"()))));



CREATE POLICY "support_tickets_insert_concerned" ON "public"."support_tickets" FOR INSERT TO "authenticated" WITH CHECK (("client_id" IN ( SELECT "c"."id"
   FROM "public"."clients" "c"
  WHERE ("c"."auth_user_id" = "auth"."uid"()))));



CREATE POLICY "support_tickets_select_concerned" ON "public"."support_tickets" FOR SELECT TO "authenticated" USING (("client_id" IN ( SELECT "c"."id"
   FROM "public"."clients" "c"
  WHERE ("c"."auth_user_id" = "auth"."uid"()))));



CREATE POLICY "support_tickets_update_concerned" ON "public"."support_tickets" FOR UPDATE TO "authenticated" USING (("client_id" IN ( SELECT "c"."id"
   FROM "public"."clients" "c"
  WHERE ("c"."auth_user_id" = "auth"."uid"())))) WITH CHECK (("client_id" IN ( SELECT "c"."id"
   FROM "public"."clients" "c"
  WHERE ("c"."auth_user_id" = "auth"."uid"()))));



ALTER TABLE "public"."system_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "system_settings_delete_admin" ON "public"."system_settings" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text")))));



CREATE POLICY "system_settings_insert_admin" ON "public"."system_settings" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text")))));



CREATE POLICY "system_settings_select_authed" ON "public"."system_settings" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "system_settings_update_admin" ON "public"."system_settings" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."auth_user_id" = "auth"."uid"()) AND ("c"."role" = 'admin'::"text")))));



CREATE POLICY "tickets_insert_public_safe" ON "public"."support_tickets" FOR INSERT TO "authenticated", "anon" WITH CHECK ((("message" IS NOT NULL) AND ("message" <> ''::"text") AND (("client_email" IS NOT NULL) OR ("convoyeur_email" IS NOT NULL) OR ("client_id" IS NOT NULL))));



CREATE POLICY "tickets_select_own_or_admin" ON "public"."support_tickets" FOR SELECT USING (("public"."is_admin"() OR ("client_email" = ( SELECT "clients"."email"
   FROM "public"."clients"
  WHERE ("clients"."auth_user_id" = "auth"."uid"()))) OR ("convoyeur_email" = ( SELECT "convoyeurs"."email"
   FROM "public"."convoyeurs"
  WHERE ("convoyeurs"."auth_user_id" = "auth"."uid"())))));



CREATE POLICY "tickets_update_admin" ON "public"."support_tickets" FOR UPDATE USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."vehicules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vehicules_delete_own" ON "public"."vehicules" FOR DELETE TO "authenticated" USING (("client_id" IN ( SELECT "c"."id"
   FROM "public"."clients" "c"
  WHERE ("c"."auth_user_id" = "auth"."uid"()))));



CREATE POLICY "vehicules_insert_own" ON "public"."vehicules" FOR INSERT TO "authenticated" WITH CHECK (("client_id" IN ( SELECT "c"."id"
   FROM "public"."clients" "c"
  WHERE ("c"."auth_user_id" = "auth"."uid"()))));



CREATE POLICY "vehicules_select_own" ON "public"."vehicules" FOR SELECT TO "authenticated" USING (("client_id" IN ( SELECT "c"."id"
   FROM "public"."clients" "c"
  WHERE ("c"."auth_user_id" = "auth"."uid"()))));



CREATE POLICY "vehicules_update_own" ON "public"."vehicules" FOR UPDATE TO "authenticated" USING (("client_id" IN ( SELECT "c"."id"
   FROM "public"."clients" "c"
  WHERE ("c"."auth_user_id" = "auth"."uid"())))) WITH CHECK (("client_id" IN ( SELECT "c"."id"
   FROM "public"."clients" "c"
  WHERE ("c"."auth_user_id" = "auth"."uid"()))));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_delete_user"("target_id" "uuid", "target_table" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_user"("target_id" "uuid", "target_table" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_delete_user"("target_id" "uuid", "target_table" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_toggle_ban"("target_id" "uuid", "target_table" "text", "ban_status" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_toggle_ban"("target_id" "uuid", "target_table" "text", "ban_status" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_toggle_ban"("target_id" "uuid", "target_table" "text", "ban_status" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."apply_parrainage_code"("code_input" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_parrainage_code"("code_input" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_parrainage_code"("code_input" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."auto_link_missions_to_client"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."auto_link_missions_to_client"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_auth_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";



REVOKE ALL ON FUNCTION "public"."is_admin_by_email"("user_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_admin_by_email"("user_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin_by_email"("user_email" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."like_reseau_post"("post_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."like_reseau_post"("post_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."like_reseau_post"("post_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reseau_comments_set_author_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reseau_comments_set_author_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_avis_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_avis_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_clients_auth_user_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_clients_auth_user_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_clients_auth_user_id_on_update"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_clients_auth_user_id_on_update"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_newsletter_unsubscribe_token"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_newsletter_unsubscribe_token"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."unsubscribe_newsletter_by_token"("token_input" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."unsubscribe_newsletter_by_token"("token_input" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."unsubscribe_newsletter_by_token"("token_input" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unsubscribe_newsletter_by_token"("token_input" "text") TO "service_role";



GRANT ALL ON TABLE "public"."avis" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."avis" TO "authenticated";



GRANT ALL ON TABLE "public"."badges" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."badges" TO "authenticated";



GRANT ALL ON TABLE "public"."campagnes" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."campagnes" TO "authenticated";



GRANT ALL ON TABLE "public"."candidatures" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."candidatures" TO "authenticated";



GRANT ALL ON TABLE "public"."clients" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."clients" TO "authenticated";



GRANT ALL ON TABLE "public"."convoyeur_badges" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."convoyeur_badges" TO "authenticated";



GRANT ALL ON TABLE "public"."convoyeur_candidatures" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."convoyeur_candidatures" TO "authenticated";



GRANT ALL ON TABLE "public"."convoyeurs" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."convoyeurs" TO "authenticated";



GRANT ALL ON TABLE "public"."convoyeurs_public" TO "service_role";
GRANT SELECT ON TABLE "public"."convoyeurs_public" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."convoyeurs_public" TO "authenticated";



GRANT ALL ON TABLE "public"."devis" TO "service_role";
GRANT INSERT ON TABLE "public"."devis" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."devis" TO "authenticated";



GRANT ALL ON TABLE "public"."edls" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."edls" TO "authenticated";



GRANT ALL ON TABLE "public"."missions" TO "service_role";
GRANT SELECT ON TABLE "public"."missions" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."missions" TO "authenticated";



GRANT ALL ON TABLE "public"."newsletter_subscribers" TO "service_role";
GRANT INSERT ON TABLE "public"."newsletter_subscribers" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."newsletter_subscribers" TO "authenticated";



GRANT ALL ON TABLE "public"."parrainages" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."parrainages" TO "authenticated";



GRANT ALL ON TABLE "public"."points_fidelite" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."points_fidelite" TO "authenticated";



GRANT ALL ON TABLE "public"."promo_codes" TO "anon";
GRANT ALL ON TABLE "public"."promo_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."promo_codes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."promo_codes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."promo_codes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."promo_codes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."push_subscriptions" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."push_subscriptions" TO "authenticated";



GRANT ALL ON TABLE "public"."reseau_comments" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."reseau_comments" TO "authenticated";



GRANT ALL ON TABLE "public"."reseau_posts" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."reseau_posts" TO "authenticated";



GRANT ALL ON TABLE "public"."solde_fidelite" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."solde_fidelite" TO "authenticated";



GRANT ALL ON TABLE "public"."support_tickets" TO "service_role";
GRANT INSERT ON TABLE "public"."support_tickets" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."support_tickets" TO "authenticated";



GRANT ALL ON TABLE "public"."system_settings" TO "service_role";
GRANT SELECT ON TABLE "public"."system_settings" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."system_settings" TO "authenticated";



GRANT ALL ON TABLE "public"."vehicules" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."vehicules" TO "authenticated";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







