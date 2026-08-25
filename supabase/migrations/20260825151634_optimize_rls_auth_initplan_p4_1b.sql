-- P4.1b: cache row-independent Supabase Auth helpers once per statement in RLS policies.
-- Policy names, commands, roles, permissiveness, helper functions, and business predicates are unchanged.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER POLICY "avis_insert_auth_safe" ON "public"."avis"
  WITH CHECK (((user_id IS NULL) OR (user_id = (select auth.uid()))) AND (auteur_email IS NOT NULL));

ALTER POLICY "avis_update_own" ON "public"."avis"
  USING ((user_id = (select auth.uid())) AND (statut = 'en_attente'::text))
  WITH CHECK ((user_id = (select auth.uid())) AND (statut = 'en_attente'::text));

ALTER POLICY "candidatures_select_own_or_admin_b1" ON "public"."candidatures"
  USING (is_admin() OR (convoyeur_id IN ( SELECT c.id
     FROM convoyeurs c
    WHERE (c.auth_user_id = (select auth.uid())))) OR (mission_id IN ( SELECT m.id
     FROM missions m
    WHERE ((m.client_id IN ( SELECT cl.id
             FROM clients cl
            WHERE (cl.auth_user_id = (select auth.uid())))) OR (m.client_email = ((select auth.jwt()) ->> 'email'::text))))));

ALTER POLICY "clients_delete_admin" ON "public"."clients"
  USING (EXISTS ( SELECT 1
     FROM clients c_admin
    WHERE ((c_admin.auth_user_id = (select auth.uid())) AND (c_admin.role = 'admin'::text))));

ALTER POLICY "clients_delete_admin_rpc" ON "public"."clients"
  USING (EXISTS ( SELECT 1
     FROM clients c_admin
    WHERE ((c_admin.auth_user_id = (select auth.uid())) AND (c_admin.role = 'admin'::text))));

ALTER POLICY "clients_insert_admin" ON "public"."clients"
  WITH CHECK (EXISTS ( SELECT 1
     FROM clients c_admin
    WHERE ((c_admin.auth_user_id = (select auth.uid())) AND (c_admin.role = 'admin'::text))));

ALTER POLICY "clients_insert_authenticated" ON "public"."clients"
  WITH CHECK (auth_user_id = (select auth.uid()));

ALTER POLICY "clients_insert_own" ON "public"."clients"
  WITH CHECK (auth_user_id = (select auth.uid()));

ALTER POLICY "clients_select_own" ON "public"."clients"
  USING (auth_user_id = (select auth.uid()));

ALTER POLICY "clients_select_own_or_admin" ON "public"."clients"
  USING (is_admin() OR (auth_user_id = (select auth.uid())) OR (email = ((select auth.jwt()) ->> 'email'::text)));

ALTER POLICY "clients_update_own_strict" ON "public"."clients"
  USING (auth_user_id = (select auth.uid()))
  WITH CHECK (auth_user_id = (select auth.uid()));

ALTER POLICY "conv_badges_select_own" ON "public"."convoyeur_badges"
  USING (user_id = (select auth.uid()));

ALTER POLICY "candidatures_conv_select_own" ON "public"."convoyeur_candidatures"
  USING (email = ((select auth.jwt()) ->> 'email'::text));

ALTER POLICY "convoyeurs_delete_admin" ON "public"."convoyeurs"
  USING (EXISTS ( SELECT 1
     FROM clients c_admin
    WHERE ((c_admin.auth_user_id = (select auth.uid())) AND (c_admin.role = 'admin'::text))));

ALTER POLICY "convoyeurs_delete_admin_rpc" ON "public"."convoyeurs"
  USING (EXISTS ( SELECT 1
     FROM clients c_admin
    WHERE ((c_admin.auth_user_id = (select auth.uid())) AND (c_admin.role = 'admin'::text))));

ALTER POLICY "convoyeurs_insert_admin" ON "public"."convoyeurs"
  WITH CHECK (EXISTS ( SELECT 1
     FROM clients c_admin
    WHERE ((c_admin.auth_user_id = (select auth.uid())) AND (c_admin.role = 'admin'::text))));

ALTER POLICY "convoyeurs_insert_own" ON "public"."convoyeurs"
  WITH CHECK ((auth_user_id = (select auth.uid())) AND (is_internal_user() OR external_convoyeurs_enabled()));

ALTER POLICY "convoyeurs_select_admin" ON "public"."convoyeurs"
  USING ((banned = false) AND (EXISTS ( SELECT 1
     FROM clients c
    WHERE ((c.auth_user_id = (select auth.uid())) AND (c.role = 'admin'::text)))));

ALTER POLICY "convoyeurs_select_own" ON "public"."convoyeurs"
  USING ((auth_user_id = (select auth.uid())) AND (banned = false));

ALTER POLICY "convoyeurs_select_own_or_admin" ON "public"."convoyeurs"
  USING (is_admin() OR (auth_user_id = (select auth.uid())) OR (email = ((select auth.jwt()) ->> 'email'::text)));

ALTER POLICY "convoyeurs_update_own" ON "public"."convoyeurs"
  USING (auth_user_id = (select auth.uid()))
  WITH CHECK (auth_user_id = (select auth.uid()));

ALTER POLICY "devis_select_admin_or_own" ON "public"."devis"
  USING (is_admin() OR (client_email = ((select auth.jwt()) ->> 'email'::text)));

ALTER POLICY "devis_select_own_or_admin" ON "public"."devis"
  USING (is_admin() OR (client_email = ((select auth.jwt()) ->> 'email'::text)));

ALTER POLICY "edls_select_client_b2" ON "public"."edls"
  USING (is_admin() OR (EXISTS ( SELECT 1
     FROM missions m
    WHERE ((m.id = edls.mission_id) AND ((m.client_id IN ( SELECT c.id
             FROM clients c
            WHERE (c.auth_user_id = (select auth.uid())))) OR (m.client_email = ((select auth.jwt()) ->> 'email'::text)))))) OR ((EXISTS ( SELECT 1
     FROM (missions m
       JOIN convoyeurs c ON ((c.id = m.convoyeur_id)))
    WHERE ((m.id = edls.mission_id) AND (c.auth_user_id = (select auth.uid()))))) AND (is_internal_user() OR external_convoyeurs_enabled())));

ALTER POLICY "mission_events_client_select_b2" ON "public"."mission_events"
  USING (is_admin() OR (EXISTS ( SELECT 1
     FROM missions m
    WHERE ((m.id = mission_events.mission_id) AND ((m.client_id IN ( SELECT c.id
             FROM clients c
            WHERE (c.auth_user_id = (select auth.uid())))) OR (m.client_email = ((select auth.jwt()) ->> 'email'::text)))))));

ALTER POLICY "mission_events_convoyeur_select_b2" ON "public"."mission_events"
  USING (is_admin() OR ((EXISTS ( SELECT 1
     FROM missions m
    WHERE ((m.id = mission_events.mission_id) AND (m.convoyeur_id IN ( SELECT c.id
             FROM convoyeurs c
            WHERE (c.auth_user_id = (select auth.uid()))))))) AND (is_internal_user() OR external_convoyeurs_enabled())));

ALTER POLICY "mission_evidence_select_client_b2" ON "public"."mission_evidence"
  USING (is_admin() OR (EXISTS ( SELECT 1
     FROM missions m
    WHERE ((m.id = mission_evidence.mission_id) AND ((m.client_id IN ( SELECT c.id
             FROM clients c
            WHERE (c.auth_user_id = (select auth.uid())))) OR (m.client_email = ((select auth.jwt()) ->> 'email'::text)))))) OR ((EXISTS ( SELECT 1
     FROM (missions m
       JOIN convoyeurs c ON ((c.id = m.convoyeur_id)))
    WHERE ((m.id = mission_evidence.mission_id) AND (c.auth_user_id = (select auth.uid()))))) AND (is_internal_user() OR external_convoyeurs_enabled())));

ALTER POLICY "mission_expense_receipts_select_operator_assigned" ON "public"."mission_expense_receipts"
  USING (is_operator() AND (created_by = (select auth.uid())) AND (EXISTS ( SELECT 1
     FROM (mission_expenses me
       JOIN missions m ON ((m.id = me.mission_id)))
    WHERE ((me.id = mission_expense_receipts.expense_id) AND (me.submitted_by = (select auth.uid())) AND (m.convoyeur_id IN ( SELECT c.id
             FROM convoyeurs c
            WHERE (c.auth_user_id = (select auth.uid()))))))));

ALTER POLICY "mission_expenses_select_operator_assigned" ON "public"."mission_expenses"
  USING (is_operator() AND (submitted_by = (select auth.uid())) AND (EXISTS ( SELECT 1
     FROM missions m
    WHERE ((m.id = mission_expenses.mission_id) AND (m.convoyeur_id IN ( SELECT c.id
             FROM convoyeurs c
            WHERE (c.auth_user_id = (select auth.uid()))))))));

ALTER POLICY "gps_positions_insert_b3" ON "public"."mission_gps_positions"
  WITH CHECK ((created_by = (select auth.uid())) AND (EXISTS ( SELECT 1
     FROM missions m
    WHERE ((m.id = mission_gps_positions.mission_id) AND (m.status = 'in_progress'::text) AND (m.convoyeur_id IN ( SELECT c.id
             FROM convoyeurs c
            WHERE (c.auth_user_id = (select auth.uid()))))))));

ALTER POLICY "gps_positions_select_b3" ON "public"."mission_gps_positions"
  USING (EXISTS ( SELECT 1
     FROM missions m
    WHERE ((m.id = mission_gps_positions.mission_id) AND (is_admin() OR (m.client_id IN ( SELECT c.id
             FROM clients c
            WHERE (c.auth_user_id = (select auth.uid())))) OR (m.convoyeur_id IN ( SELECT c.id
             FROM convoyeurs c
            WHERE (c.auth_user_id = (select auth.uid()))))))));

ALTER POLICY "mission_incident_evidence_select_operator_assigned" ON "public"."mission_incident_evidence"
  USING (is_operator() AND (EXISTS ( SELECT 1
     FROM (mission_incidents mi
       JOIN missions m ON ((m.id = mi.mission_id)))
    WHERE ((mi.id = mission_incident_evidence.incident_id) AND (m.convoyeur_id IN ( SELECT c.id
             FROM convoyeurs c
            WHERE (c.auth_user_id = (select auth.uid()))))))));

ALTER POLICY "mission_incidents_select_operator_assigned" ON "public"."mission_incidents"
  USING (is_operator() AND (EXISTS ( SELECT 1
     FROM missions m
    WHERE ((m.id = mission_incidents.mission_id) AND (m.convoyeur_id IN ( SELECT c.id
             FROM convoyeurs c
            WHERE (c.auth_user_id = (select auth.uid()))))))));

ALTER POLICY "tracking_tokens_insert_b3" ON "public"."mission_tracking_tokens"
  WITH CHECK (EXISTS ( SELECT 1
     FROM missions m
    WHERE ((m.id = mission_tracking_tokens.mission_id) AND (is_admin() OR (m.client_id IN ( SELECT c.id
             FROM clients c
            WHERE (c.auth_user_id = (select auth.uid())))) OR (m.convoyeur_id IN ( SELECT c.id
             FROM convoyeurs c
            WHERE (c.auth_user_id = (select auth.uid()))))))));

ALTER POLICY "tracking_tokens_select_b3" ON "public"."mission_tracking_tokens"
  USING (EXISTS ( SELECT 1
     FROM missions m
    WHERE ((m.id = mission_tracking_tokens.mission_id) AND (is_admin() OR (m.client_id IN ( SELECT c.id
             FROM clients c
            WHERE (c.auth_user_id = (select auth.uid())))) OR (m.convoyeur_id IN ( SELECT c.id
             FROM convoyeurs c
            WHERE (c.auth_user_id = (select auth.uid()))))))));

ALTER POLICY "missions_select_b3" ON "public"."missions"
  USING (is_admin() OR is_operator() OR (client_id IN ( SELECT c.id
     FROM clients c
    WHERE (c.auth_user_id = (select auth.uid())))) OR (client_email = ((select auth.jwt()) ->> 'email'::text)) OR ((convoyeur_id IN ( SELECT c.id
     FROM convoyeurs c
    WHERE (c.auth_user_id = (select auth.uid())))) AND (is_internal_user() OR external_convoyeurs_enabled())) OR ((status = 'available'::text) AND (is_internal_user() OR external_convoyeurs_enabled())));

ALTER POLICY "newsletter_update_own" ON "public"."newsletter_subscribers"
  USING (email = ((select auth.jwt()) ->> 'email'::text))
  WITH CHECK (email = ((select auth.jwt()) ->> 'email'::text));

ALTER POLICY "parrainages_insert_own" ON "public"."parrainages"
  WITH CHECK (parrain_id = (select auth.uid()));

ALTER POLICY "parrainages_select_own" ON "public"."parrainages"
  USING ((parrain_id = (select auth.uid())) OR (filleul_id = (select auth.uid())));

ALTER POLICY "parrainages_update_own" ON "public"."parrainages"
  USING (parrain_id = (select auth.uid()))
  WITH CHECK (parrain_id = (select auth.uid()));

ALTER POLICY "points_insert_own" ON "public"."points_fidelite"
  WITH CHECK (user_id = (select auth.uid()));

ALTER POLICY "points_select_own" ON "public"."points_fidelite"
  USING (user_id = (select auth.uid()));

ALTER POLICY "push_delete_own" ON "public"."push_subscriptions"
  USING (user_id = (select auth.uid()));

ALTER POLICY "push_insert_own" ON "public"."push_subscriptions"
  WITH CHECK (user_id = (select auth.uid()));

ALTER POLICY "push_select_own" ON "public"."push_subscriptions"
  USING (user_id = (select auth.uid()));

ALTER POLICY "reseau_comments_delete_admin" ON "public"."reseau_comments"
  USING (EXISTS ( SELECT 1
     FROM clients c
    WHERE ((c.auth_user_id = (select auth.uid())) AND (c.role = 'admin'::text))));

ALTER POLICY "reseau_comments_insert_admin_or_convoyeur" ON "public"."reseau_comments"
  WITH CHECK ((EXISTS ( SELECT 1
     FROM clients c
    WHERE ((c.auth_user_id = (select auth.uid())) AND (c.role = 'admin'::text)))) OR ((is_internal_user() OR external_convoyeurs_enabled()) AND (EXISTS ( SELECT 1
     FROM convoyeurs v
    WHERE ((v.auth_user_id = (select auth.uid())) AND (v.banned = false))))));

ALTER POLICY "reseau_comments_select_admin_or_convoyeur" ON "public"."reseau_comments"
  USING ((EXISTS ( SELECT 1
     FROM clients c
    WHERE ((c.auth_user_id = (select auth.uid())) AND (c.role = 'admin'::text)))) OR ((is_internal_user() OR external_convoyeurs_enabled()) AND (EXISTS ( SELECT 1
     FROM convoyeurs v
    WHERE ((v.auth_user_id = (select auth.uid())) AND (v.banned = false))))));

ALTER POLICY "reseau_posts_delete_admin" ON "public"."reseau_posts"
  USING (EXISTS ( SELECT 1
     FROM clients c
    WHERE ((c.auth_user_id = (select auth.uid())) AND (c.role = 'admin'::text))));

ALTER POLICY "reseau_posts_insert_admin_or_convoyeur" ON "public"."reseau_posts"
  WITH CHECK ((EXISTS ( SELECT 1
     FROM clients c
    WHERE ((c.auth_user_id = (select auth.uid())) AND (c.role = 'admin'::text)))) OR ((is_internal_user() OR external_convoyeurs_enabled()) AND (EXISTS ( SELECT 1
     FROM convoyeurs v
    WHERE ((v.auth_user_id = (select auth.uid())) AND (v.banned = false))))));

ALTER POLICY "reseau_posts_select_admin_or_convoyeur" ON "public"."reseau_posts"
  USING ((EXISTS ( SELECT 1
     FROM clients c
    WHERE ((c.auth_user_id = (select auth.uid())) AND (c.role = 'admin'::text)))) OR ((is_internal_user() OR external_convoyeurs_enabled()) AND (EXISTS ( SELECT 1
     FROM convoyeurs v
    WHERE ((v.auth_user_id = (select auth.uid())) AND (v.banned = false))))));

ALTER POLICY "support_tickets_delete_concerned" ON "public"."support_tickets"
  USING (client_id IN ( SELECT c.id
     FROM clients c
    WHERE (c.auth_user_id = (select auth.uid()))));

ALTER POLICY "support_tickets_insert_concerned" ON "public"."support_tickets"
  WITH CHECK (client_id IN ( SELECT c.id
     FROM clients c
    WHERE (c.auth_user_id = (select auth.uid()))));

ALTER POLICY "support_tickets_select_concerned" ON "public"."support_tickets"
  USING (client_id IN ( SELECT c.id
     FROM clients c
    WHERE (c.auth_user_id = (select auth.uid()))));

ALTER POLICY "support_tickets_update_concerned" ON "public"."support_tickets"
  USING (client_id IN ( SELECT c.id
     FROM clients c
    WHERE (c.auth_user_id = (select auth.uid()))))
  WITH CHECK (client_id IN ( SELECT c.id
     FROM clients c
    WHERE (c.auth_user_id = (select auth.uid()))));

ALTER POLICY "tickets_select_own_or_admin" ON "public"."support_tickets"
  USING (is_admin() OR (client_email = ( SELECT clients.email
     FROM clients
    WHERE (clients.auth_user_id = (select auth.uid())))) OR (convoyeur_email = ( SELECT convoyeurs.email
     FROM convoyeurs
    WHERE (convoyeurs.auth_user_id = (select auth.uid())))));

ALTER POLICY "system_settings_delete_admin" ON "public"."system_settings"
  USING (EXISTS ( SELECT 1
     FROM clients c
    WHERE ((c.auth_user_id = (select auth.uid())) AND (c.role = 'admin'::text))));

ALTER POLICY "system_settings_insert_admin" ON "public"."system_settings"
  WITH CHECK (EXISTS ( SELECT 1
     FROM clients c
    WHERE ((c.auth_user_id = (select auth.uid())) AND (c.role = 'admin'::text))));

ALTER POLICY "system_settings_update_admin" ON "public"."system_settings"
  USING (EXISTS ( SELECT 1
     FROM clients c
    WHERE ((c.auth_user_id = (select auth.uid())) AND (c.role = 'admin'::text))))
  WITH CHECK (EXISTS ( SELECT 1
     FROM clients c
    WHERE ((c.auth_user_id = (select auth.uid())) AND (c.role = 'admin'::text))));

ALTER POLICY "vehicules_delete_own" ON "public"."vehicules"
  USING (client_id IN ( SELECT c.id
     FROM clients c
    WHERE (c.auth_user_id = (select auth.uid()))));

ALTER POLICY "vehicules_insert_own" ON "public"."vehicules"
  WITH CHECK (client_id IN ( SELECT c.id
     FROM clients c
    WHERE (c.auth_user_id = (select auth.uid()))));

ALTER POLICY "vehicules_select_own" ON "public"."vehicules"
  USING (client_id IN ( SELECT c.id
     FROM clients c
    WHERE (c.auth_user_id = (select auth.uid()))));

ALTER POLICY "vehicules_update_own" ON "public"."vehicules"
  USING (client_id IN ( SELECT c.id
     FROM clients c
    WHERE (c.auth_user_id = (select auth.uid()))))
  WITH CHECK (client_id IN ( SELECT c.id
     FROM clients c
    WHERE (c.auth_user_id = (select auth.uid()))));

COMMIT;
