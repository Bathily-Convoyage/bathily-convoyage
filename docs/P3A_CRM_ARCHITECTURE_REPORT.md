# P3A — CRM / COMMERCIAL ADMIN ARCHITECTURE & DATA MODEL

> Design-only. No production mutation. No code, no migration, no DB write, no push, no PR, no merge, no deployment.
>
> **HARDENED BY P3A1** — see `docs/P3A1_CRM_HARDENING_REPORT.md` for authoritative corrections:
> - `crm_prospects` table ELIMINATED → prospect is an early-stage `crm_opportunities` row (stage='lead' with lead_* fields).
> - `organization_memberships` (future B2B auth, not in P3) added to the model; `clients.organization_id` is data-link only, not authorization.
> - `crm_timeline` view fields stabilized (event_id = source:pk, deterministic ordering, security_invoker).
> - Pipeline event immutability enforced via RPC-only INSERT + UPDATE/DELETE triggers.
> - RLS predicate unified to `is_internal_user()` (= is_admin() OR is_operator()).
> - SECURITY DEFINER RPC rules classified (transition/convert/merge/bulk-import only).

---

## 1. BASELINE

```
MAIN_SHA=6817a55b60d86857f8421a540af0a8044bea913d
WORKTREE_CLEAN=NO (this report file is untracked; corrected in P3A1)
LOCAL_MAIN=6817a55b60d86857f8421a540af0a8044bea913d
ORIGIN_MAIN=6817a55b60d86857f8421a540af0a8044bea913d
MAIN_SYNCED=YES
```
P2 is closed and must not be modified. HEAD == main == origin/main.

---

## 2. EXISTING DATA MODEL AUDIT

### TABLE: clients
- PRIMARY_KEY: id (uuid)
- CLIENT_LINK: self (this IS the customer entity)
- ORG_LINK: NONE — no organization concept. `societe` / `entreprise` / `siret` / `tva_intra` / `is_pro` / `pro_status` are flat columns on the client row.
- AUTH_LINK: `auth_user_id uuid` → auth.users (no enforced FK in baseline; logical link). `role text` defaults `'client'`, also carries `'admin'` (legacy admin flag).
- IMPORTANT_COLUMNS: email, nom, prenom, telephone, societe, entreprise, siret, tva_intra, role, is_pro, pro_status, auth_user_id, banned, adresse, code_postal, ville, pays, notes, notes_admin
- RLS: ENABLED. SELECT own-or-admin; INSERT own / admin / anon-safe (no auth_user_id, not admin); UPDATE own-strict; DELETE admin.
- CURRENT_USAGE: Primary customer record. Doubles as admin identity store (`role='admin'`). Linked 1:1 to auth.users via auth_user_id. Used by missions.client_id (FK), billing_records.client_id (FK), support_tickets.client_id (FK), vehicules.client_id.
- CRM_REUSE_POTENTIAL: HIGH. Already holds B2B fields (siret, tva_intra, is_pro, entreprise). Best reused as the "client/person" anchor with an optional organization link added later. Do NOT replace.

### TABLE: convoyeurs
- PRIMARY_KEY: id (uuid)
- CLIENT_LINK: none
- ORG_LINK: none (has own siret/iban — independent contractor, not a CRM org)
- AUTH_LINK: auth_user_id → auth.users
- IMPORTANT_COLUMNS: nom, prenom, email, telephone, siret, iban, zone, taux_auto, taux_moto, statut, auth_user_id, banned
- RLS: ENABLED (admin + own)
- CURRENT_USAGE: Driver/contractor registry. NOT a commercial partner. Out of CRM scope (supplier-side, not customer-side).
- CRM_REUSE_POTENTIAL: LOW for CRM. Keep separate.

### TABLE: devis
- PRIMARY_KEY: id (uuid)
- CLIENT_LINK: `client_id uuid` (NO enforced FK in schema) + snapshot `client_nom`, `client_prenom`, `client_email`
- ORG_LINK: none
- AUTH_LINK: none (created by anon/public quote form or admin)
- IMPORTANT_COLUMNS: reference, client_nom, client_prenom, client_email, client_id, depart, arrivee, vehicule, total_ht, status, details(jsonb), mode, pack, date_depart, date_livraison, heure_livraison, vehicle_condition, utilitaire_size, is_collection, relance_envoyee
- RLS: ENABLED (admin read; anon insert for public quote form)
- CURRENT_USAGE: Quote requests from public site + admin-created. `status` text (pending/accepted/expired/...). On `accepted`, admin frontend copies devis fields into a new `missions` row (no DB-level link).
- CRM_REUSE_POTENTIAL: HIGH. This is the de-facto "opportunity/quote" stage. Should become the quote stage of the pipeline, with an explicit FK to organizations/contacts and a back-reference from missions.

### TABLE: missions
- PRIMARY_KEY: id (uuid)
- CLIENT_LINK: `client_id uuid` FK→clients(id) (ON DELETE no action / SET NULL per migration) + snapshot client_nom, client_email, client_telephone
- ORG_LINK: none
- AUTH_LINK: convoyeur_id (FK→convoyeurs), client_id (FK→clients)
- IMPORTANT_COLUMNS: reference, client_id, convoyeur_id, status, paiement_statut, montant_ht, marge, remuneration_convoyeur, mode, pack, departure_at, expected_arrival_at, distance_km, status CHECK(available/planned/in_progress/completed/cancelled/archived)
- RLS: ENABLED
- CURRENT_USAGE: Core operational record. **No devis_id** — link to originating quote is implicit (frontend copies data on accept).
- CRM_REUSE_POTENTIAL: MEDIUM. Add nullable `devis_id` FK + optional `organization_id` for B2B traceability. Snapshots remain for legal/audit.

### TABLE: billing_records
- PRIMARY_KEY: id (uuid)
- CLIENT_LINK: client_id FK→clients (ON DELETE RESTRICT)
- ORG_LINK: none
- AUTH_LINK: created_by uuid
- IMPORTANT_COLUMNS: mission_id FK→missions(RESTRICT), provider, status(prepared/issued/cancelled), invoice_type(invoice/credit_note), external_invoice_id, external_invoice_number, total_ht, total_tva, total_ttc, prepared_payload(jsonb), issued_at, cancelled_at
- RLS: ENABLED (admin/operator)
- CURRENT_USAGE: Indy manual-assisted invoicing. Strong state machine with CHECK constraints + immutable terminal state.
- CRM_REUSE_POTENTIAL: HIGH as a PATTERN TEMPLATE. The status CHECK + lifecycle consistency constraints + billing_events audit trail is exactly the model to mirror for the sales pipeline.

### TABLE: billing_events
- PRIMARY_KEY: id (uuid)
- CLIENT_LINK: via billing_record_id
- IMPORTANT_COLUMNS: billing_record_id FK(RESTRICT), event_type, from_status, to_status, actor_user_id, actor_role, metadata(jsonb), created_at
- RLS: ENABLED
- CURRENT_USAGE: Append-only audit of billing state transitions.
- CRM_REUSE_POTENTIAL: HIGH as PATTERN. Mirror for `pipeline_events` (auditable stage transitions).

### TABLE: support_tickets
- PRIMARY_KEY: id (uuid)
- CLIENT_LINK: client_id FK→clients(SET NULL) + client_email snapshot
- AUTH_LINK: none direct
- IMPORTANT_COLUMNS: mission_id FK→missions(SET NULL), sujet, message, statut(ouvert/en_cours/resolu/ferme), priorite, reponse_admin, repondu_at
- RLS: ENABLED (own insert/select; admin via service_role)
- CURRENT_USAGE: Customer support requests.
- CRM_REUSE_POTENTIAL: MEDIUM. Could surface in CRM timeline as a contact event; keep as-is, link to organization/contact optionally.

### TABLE: system_settings
- PRIMARY_KEY: key (text)
- IMPORTANT_COLUMNS: key, value(jsonb), updated_at
- RLS: ENABLED (admin)
- CURRENT_USAGE: Key-value config (tarifs, packs, etc.).
- CRM_REUSE_POTENTIAL: MEDIUM. Store pipeline stage definitions / dropdown enums here as JSON config (no new enum table needed).

### TABLE: user_roles
- PRIMARY_KEY: (user_id, role)
- AUTH_LINK: user_id FK→auth.users(CASCADE); role IN ('admin','operator')
- RLS: ENABLED, all direct grants revoked (no user-write policies)
- CURRENT_USAGE: Modern admin/operator role store. `is_admin()` / `is_operator()` read from here.
- CRM_REUSE_POTENTIAL: HIGH. Add `'commercial'` role here later for the future commercial user. No schema change needed to the table itself (CHECK can be extended).

### TABLE: internal_operators
- PRIMARY_KEY: user_id FK→auth.users
- IMPORTANT_COLUMNS: display_name, active
- RLS: ENABLED, grants revoked
- CURRENT_USAGE: Operator profile + active flag for `is_operator()`.
- CRM_REUSE_POTENTIAL: MEDIUM. Pattern reusable for a future `commercial_profiles` table or extend this.

### TABLE: avis
- PRIMARY_KEY: id (uuid)
- CLIENT_LINK: user_id, auteur_email, mission_id
- IMPORTANT_COLUMNS: auteur_type(client/convoyeur/visiteur), note(1-5), statut(en_attente/approuve/rejete), reponse_admin, source
- RLS: ENABLED
- CURRENT_USAGE: Public reviews moderation.
- CRM_REUSE_POTENTIAL: LOW for CRM core; could appear in org timeline.

### Other tables (out of CRM core): vehicules, edls, candidatures, convoyeur_candidatures, badges, convoyeur_badges, points_fidelite, newsletter_subscribers, campagnes, push_subscriptions, outbox.

### KEY STRUCTURAL FINDINGS
1. **No CRM tables exist** — prospect, pipeline, organization, contact, activity, timeline are entirely greenfield.
2. **`clients` is overloaded**: it is simultaneously the customer entity AND the admin identity store (`role='admin'`). Any CRM party model must NOT break this.
3. **devis→mission link is implicit**: no `devis_id` on missions, no FK from `devis.client_id`. Commercial traceability is currently enforced only by frontend convention.
4. **B2B fields already exist on clients** (siret, tva_intra, entreprise, societe, is_pro) — partially supports organizations but with no multi-contact / multi-site model.
5. **billing_records/billing_events** provide a proven auditable state-machine pattern to mirror for the pipeline.

---

## 3. CRM BUSINESS MODEL

### Decision: generalized organization model with typed segments (NOT per-partner-type tables)

A single `organizations` table with a many-to-many `organization_segments` join supports all partner types (concession, garage, rental, auction, notary, fleet, leasing, dealer, logistics, other) without duplicating the same company across N tables.

Relationships supported:
- 1 organization → N contacts (`organization_contacts`)
- 1 organization → N sites (`organization_sites`)
- 1 organization → N users (future B2B; via `clients.auth_user_id` or a future `organization_members`)
- 1 organization → N devis
- 1 organization → N missions
- contact → organization (N:1)
- prospect → organization/contact (prospect is a lightweight lead that may predate an organization)
- conversion prospect → client (prospect becomes a `clients` row, optionally linked to an organization)

### Why not separate tables per partner type
A garage that is also a dealer, or a rental company that also runs a fleet, would be duplicated across `garages`, `dealers`, `rentals` tables. A generalized org + segment tags avoids this and keeps one commercial history per real-world company.

---

## 4. PIPELINE COMMERCIAL

```
PIPELINE_TABLE_NEEDED=YES  -> public.crm_opportunities (one row per commercial opportunity)
STATUS_ENUM_OR_TEXT=TEXT + CHECK constraint (mirrors billing_records pattern)
```

Deterministic stages (stored as `stage text CHECK IN (...)`):
`lead → qualified → contacted → meeting → quote_requested → quote_sent → negotiating → won → lost → dormant`

- `LOST_REASON`: nullable text (free) + optional enum-ish values stored in system_settings (price, competitor, no_response, disqualified, other). Keep as text to avoid over-constraining.
- `OWNER_ADMIN`: `owner_user_id uuid` (references auth.users logically; the admin/operator responsible).
- `VALUE_ESTIMATE`: `estimated_value numeric` (nullable; EUR).
- `NEXT_ACTION`: `next_action text` (free description).
- `NEXT_ACTION_AT`: `next_action_at timestamptz` (drives "overdue follow-ups" KPI).
- `LAST_CONTACT_AT`: `last_contact_at timestamptz` (denormalized, updated by activity trigger or RPC).

Pipeline state changes are auditable via `crm_pipeline_events` (append-only, mirrors `billing_events`): from_stage, to_stage, actor_user_id, actor_role, reason, metadata, created_at.

Stage transitions are NOT free-update: an RPC `crm_transition_opportunity(opportunity_id, to_stage, reason)` enforces allowed transitions and writes the event row. Direct UPDATE of `stage` is blocked by RLS for non-admin and discouraged; the RPC is the gatekeeper.

---

## 5. ACTIVITIES / FOLLOW-UPS

Table: `public.crm_activities`

```
id, created_at, updated_at
organization_id  uuid  (nullable, FK→organizations)
contact_id       uuid  (nullable, FK→organization_contacts)
prospect_id      uuid  (nullable, FK→crm_prospects)
client_id        uuid  (nullable, FK→clients)
devis_id         uuid  (nullable, FK→devis)
mission_id       uuid  (nullable, FK→missions)
owner_user_id    uuid  (admin/operator owner)
activity_type    text  CHECK IN (call,email,meeting,visit,note,follow_up,quote,task,reminder)
due_at           timestamptz
completed_at     timestamptz
outcome          text
notes            text
metadata         jsonb
```

At least one of (organization_id, contact_id, prospect_id, client_id, devis_id, mission_id) must be non-null (CHECK constraint). This guarantees every activity is anchored to a CRM entity and history is DB-persistent, not frontend-only.

`crm_activities` is the single source of truth for follow-ups / tasks / reminders. `last_contact_at` on opportunities is refreshed from completed activities.

---

## 6. NOTES / TIMELINE / HISTORY

### Decision: unified timeline VIEW over separate event sources (NOT one giant events table)

Candidate event sources:
- crm_prospects (created)
- organization_contacts (added)
- crm_activities (call/email/meeting logged)
- devis (created, accepted, rejected, expired)
- missions (created, completed)
- billing_records (issued, cancelled)
- crm_pipeline_events (stage changed)

**Recommended structure:**
- `crm_activities` — primary, user-authored follow-ups/tasks/notes (mutable until completed).
- `crm_pipeline_events` — append-only stage transitions (immutable audit).
- `crm_timeline` — a **VIEW** (UNION of the above + key devis/mission/billing milestones) exposing one chronological feed per organization/contact/opportunity.

### Trade-offs
- **Separate tables (chosen)**: clear ownership, easy RLS per source, no single bloated table, pipeline events immutable while activities editable until completion. Slightly more complex read (UNION view).
- **Unified `crm_events` table (rejected as primary)**: simplest single read, but mixes mutable activities with immutable audit and forces one RLS shape; loses the proven billing_events immutability pattern.
- **audit_log (existing)**: there is no generic audit_log table today; billing_events is the precedent. We mirror it rather than introduce a generic audit_log.

The VIEW approach gives a unified timeline for the UI without sacrificing per-source integrity.

---

## 7. RELATION WITH EXISTING CLIENTS TABLE

### Decision: Strategy B — clients remain the primary customer/person entity; organizations become an optional parent linked to clients.

**RECOMMENDED_CLIENT_STRATEGY=B**

Rationale:
- `clients` is deeply wired: missions.client_id FK, billing_records.client_id FK, support_tickets.client_id FK, vehicules.client_id, auth_user_id, RLS, is_admin(). Replacing it (C) is high-risk and destructive.
- `clients` already carries B2B fields (siret, tva_intra, entreprise, is_pro). It can represent both a particular person and a B2B contact.
- Organizations add the missing multi-contact / multi-site / multi-user layer WITHOUT touching clients.

### Backward-compatible migration strategy (no destructive change)
1. Add `organization_id uuid NULL` to `clients` (nullable, no FK initially or FK with SET NULL). Existing rows: organization_id=NULL → behave exactly as today.
2. Add `organization_id uuid NULL` to `devis` and `missions` (nullable). Existing rows: NULL → unchanged.
3. Existing `clients` rows keep working untouched. New B2B clients get an organization_id; particular clients keep organization_id=NULL.
4. A prospect converts to a `clients` row (existing flow) and optionally gets organization_id set.
5. No data backfill required. No rename, no drop, no type change on clients.

This preserves full production compatibility: every existing query, FK, RLS policy, and frontend continues to work.

---

## 8. ORGANIZATIONS / SITES / CONTACTS

### organizations
```
id              uuid PK
legal_name      text NOT NULL
trade_name      text
siret           text UNIQUE (soft — see §16)
siren           text
vat_number      text
organization_type text  (single coarse type: company, public_org, self_employed, partner)
status          text DEFAULT 'active' CHECK IN (active,inactive,blacklisted)
website         text
email           text
phone           text
billing_email   text
billing_address text
notes           text
source          text
owner_user_id   uuid
created_at      timestamptz
updated_at      timestamptz
```

### organization_sites
```
id              uuid PK
organization_id uuid FK→organizations(CASCADE)
name            text
address         text
city            text
postal_code     text
country         text DEFAULT 'France'
phone           text
site_type       text  (concession, garage, depot, office, auction_site, other)
active          boolean DEFAULT true
created_at, updated_at
```

### organization_contacts
```
id              uuid PK
organization_id uuid FK→organizations(CASCADE)
first_name      text
last_name       text
role            text  (job title)
email           text
phone           text
mobile          text
preferred_channel text CHECK IN (email,phone,sms,none)
decision_maker  boolean DEFAULT false
active          boolean DEFAULT true
client_id       uuid NULL  (optional link to clients if the contact is also a registered client)
created_at, updated_at
```

`organization_contacts.client_id` is the bridge: a contact who registers as a client links back, so commercial history and self-service stay connected.

---

## 9. COMMERCIAL SEGMENTS

### Decision: many-to-many (organization_segments join table)

Rationale: a single org can be `garage + dealer` or `rental + fleet`. A single `organization_type` column cannot express multi-segment without abusing arrays/CSV.

```
organization_segments
  organization_id uuid FK→organizations(CASCADE)
  segment text CHECK IN (concession,garage,rental,auction,notary,fleet,leasing,dealer,logistics,other)
  PRIMARY KEY (organization_id, segment)
```

`organization_type` on `organizations` stays as a coarse classifier (company/partner/self_employed); fine-grained commercial segments live in the join table.

---

## 10. PROSPECT SOURCING

On `crm_prospects`:
```
source          text CHECK IN (website,manual,outbound_call,outbound_email,referral,auction_directory,notary_directory,concession,garage,partner,campaign,other)
source_detail   text   (free, e.g. specific directory URL or referrer name)
campaign        text   (nullable campaign identifier)
imported_at     timestamptz  (nullable; set when bulk-imported)
external_reference text (nullable; id from external CRM/directory)
```

GDPR/data-minimization: `source_detail` and `external_reference` are optional and should not store personal data beyond what is needed. No automatic scraping of directories. Bulk import records `imported_at` + `source` for traceability and later deletion/anonymization.

---

## 11. CRM -> DEVIS -> MISSION FLOW

```
prospect
  → (qualify) organization/contact created (or reused)
  → quote_requested: crm_opportunities.stage='quote_requested'
  → devis created (devis.opportunity_id FK, devis.organization_id FK, devis.contact_id FK)
  → quote_sent: opportunity.stage='quote_sent', devis.status='sent'
  → accepted quote: devis.status='accepted'
  → mission created (mission.devis_id FK NEW, mission.organization_id FK, mission.client_id FK)
  → completed mission: mission.status='completed'
  → billing: billing_records (existing) linked via mission_id
  → follow-up / repeat: crm_activity type=follow_up, opportunity reopened or new opportunity
```

### New FKs / reference fields needed (additive, nullable)
- `devis.opportunity_id uuid` FK→crm_opportunities (nullable; legacy devis rows NULL)
- `devis.organization_id uuid` FK→organizations (nullable)
- `devis.contact_id uuid` FK→organization_contacts (nullable)
- `missions.devis_id uuid` FK→devis (nullable; **closes the current implicit link**)
- `missions.organization_id uuid` FK→organizations (nullable)
- `crm_opportunities.devis_id uuid` FK→devis (nullable; the quote attached to the opportunity)

This makes commercial history traceable end-to-end at the DB level. Snapshots (client_nom, client_email on devis/missions) are KEPT for legal/audit (a quote must remain readable as issued even if the client/org is later edited).

---

## 12. ADMIN UI ARCHITECTURE (proposal, no implementation)

New CRM nav group in dashboard-admin.html (alongside existing Missions/Devis/Clients):

- Dashboard commercial (KPIs)
- Prospects
- Organisations
- Contacts
- Pipeline (kanban/list by stage)
- Relances / tâches (activities due/overdue)
- Activités (full activity log)
- Historique (crm_timeline view)

### Dashboard KPIs
- new leads (count, period)
- qualified leads
- quotes sent (devis status=sent)
- conversion rate (won / (won+lost))
- won opportunities (count + value)
- lost opportunities (count)
- pipeline value (sum estimated_value of open opportunities)
- overdue follow-ups (activities due_at < now, completed_at IS NULL)
- revenue by client (sum billing_records.total_ttc by client/organization)
- revenue by segment (by organization_segments)
- repeat clients (clients with >1 completed mission)

Existing sections (Missions, Devis, Clients, Facturation) remain; CRM enriches them (e.g. Devis list shows linked opportunity/org; Clients list shows organization).

---

## 13. SEARCH / FILTERS

Supported filters (server-side, indexed):
- name (contact first/last, org legal/trade name)
- company (org legal_name)
- contact email / phone
- SIRET (org.siret)
- city (org billing_address city, site.city)
- segment (organization_segments.segment)
- pipeline stage (crm_opportunities.stage)
- source (crm_prospects.source)
- owner (owner_user_id)
- activity due (crm_activities.due_at)
- last contact (crm_opportunities.last_contact_at)

### Indexes (proposed)
- organizations: lower(legal_name), siret, owner_user_id, status
- organization_contacts: email, organization_id
- organization_sites: organization_id, city
- crm_prospects: email, organization_id, source
- crm_opportunities: stage, owner_user_id, next_action_at, organization_id
- crm_activities: (owner_user_id, due_at) WHERE completed_at IS NULL, organization_id, contact_id
- organization_segments: organization_id (PK covers it)

---

## 14. SECURITY / RLS

### Access matrix

| Role | organizations | contacts | sites | prospects | opportunities | activities | timeline |
|------|--------------|----------|-------|-----------|---------------|-----------|----------|
| anon | NO | NO | NO | NO | NO | NO | NO |
| authenticated (client) | own org only (future) | own only (future) | NO | NO | NO | NO | NO |
| convoyeur | NO | NO | NO | NO | NO | NO | NO |
| operator (internal) | YES (CRUD) | YES | YES | YES | YES | YES | YES |
| admin | YES (CRUD) | YES | YES | YES | YES | YES | YES |
| commercial (future) | YES (own) | YES (own) | YES (own) | YES (own) | YES (own) | YES (own) | YES (own) |

### P3 baseline decision: admin + operator only
Initial P3 CRM is **admin-only** (operator included via `is_operator()`). Future `commercial` role expansion is designed for but NOT enabled in P3B (no `commercial` role in user_roles CHECK yet).

### RLS approach
- All CRM tables: `ENABLE ROW LEVEL SECURITY`, `FORCE` where needed.
- SELECT/INSERT/UPDATE/DELETE policies use `public.is_admin() OR public.is_operator()`.
- No anon, no client, no convoyeur policies on CRM tables in P3.
- Elevated operations (prospect conversion, merge duplicates, bulk import, pipeline transitions, activity logging side-effects) go through SECURITY DEFINER RPCs (service_role), NOT direct client writes.
- `clients.organization_id` is readable by the client only for their own row (existing clients RLS already restricts to own row).

---

## 15. API / RPC DESIGN

### Decision: hybrid — direct Supabase CRUD with RLS for simple reads/writes; SECURITY DEFINER RPCs for elevated/server-side logic.

**Direct CRUD (RLS-gated, admin/operator):**
- organizations, organization_sites, organization_contacts, crm_prospects, crm_activities — standard CRUD via Supabase client. RLS enforces admin/operator.

**Secure RPCs (SECURITY DEFINER, service_role):**
- `crm_convert_prospect(p_prospect_id)` → creates/links clients row + organization + contact, marks prospect converted. (elevated: cross-table atomic write)
- `crm_transition_opportunity(p_opportunity_id, p_to_stage, p_reason)` → validates allowed transition, updates stage, writes crm_pipeline_events, refreshes last_contact_at. (elevated: state machine)
- `crm_merge_organizations(p_source_id, p_target_id)` → reassigns contacts/sites/devis/missions/clients, marks source inactive. (elevated: destructive, audited)
- `crm_bulk_import_prospects(p_payload jsonb)` → dedup + insert with source/imported_at. (elevated: bulk)
- `crm_log_activity(...)` → optional; direct insert is acceptable under RLS, but an RPC can also refresh opportunity.last_contact_at atomically.

Cloudflare functions are NOT used for CRM CRUD (no need; Supabase RLS + RPCs suffice). Cloudflare remains for existing email/push/cron concerns.

---

## 16. DUPLICATE MANAGEMENT

### Hard unique constraints
- `organizations.siret` UNIQUE (when non-null) — hard block on duplicate SIRET.
- `organization_contacts` : no hard unique on email (a person can be a contact at multiple orgs); soft warning instead.

### Soft duplicate detection (RPC / admin tooling)
Match on any of:
- normalized legal_name (unaccented, lowercased, trimmed, suffix-stripped: SAS/SARL/SASU/SA)
- siret
- email (org email or contact email)
- phone (normalized, digits-only)
- billing_address normalized

A `crm_duplicate_suggestions` RPC returns candidate pairs with a match score. Admin reviews and triggers `crm_merge_organizations`.

### Merge operation
`crm_merge_organizations(source, target)`:
- reassign all FKs (contacts, sites, devis, missions, clients.organization_id, opportunities, activities) from source→target
- append source.legal_name to target.notes ("merged from ...")
- set source.status='inactive' (soft delete; keep row for audit, do not hard-delete)
- write a crm_pipeline_events-like audit entry (or a dedicated crm_merge_events)

Do NOT hard-delete the source organization (auditability + FK safety).

---

## 17. GDPR / DATA RETENTION

### Personal data
- organization_contacts: first_name, last_name, email, phone, mobile (personal/business contact data)
- crm_prospects: name, email, phone (lead personal data)
- clients: existing personal data (already governed)

### Business contact data
- organizations: legal_name, siret, vat — business data, lower sensitivity, longer retention acceptable.

### Free-text notes risks
- organizations.notes, crm_activities.notes, crm_activities.outcome — free text may inadvertently contain personal data. Mitigation: admin training + no public exposure (RLS). No automated PII scan in P3.

### Retention / deletion / anonymization
- Prospects not converted and not contacted for >3 years: candidate for anonymization (set name/email=NULL, keep aggregated stats). Implement as a future admin RPC `crm_anonymize_stale_prospects(older_than)`, NOT in P3B.
- Contacts: on request, anonymize contact row (email/phone=NULL, keep org link for history).
- Export: admin can export an organization's full timeline (crm_timeline filtered) — future.
- Auditability: crm_pipeline_events + crm_activities created_at/owner_user_id provide traceability of who did what.

No legal overengineering in P3B: implement RLS + audit events now; retention/anonymization RPCs deferred to a later phase with legal validation.

---

## 18. PROPOSED MIGRATIONS (plan only — DO NOT create/apply)

### P3B1 — organizations + segments
- TABLES: organizations, organization_segments
- COLUMNS: as in §8, §9
- FKS: none inbound yet
- INDEXES: organizations(siret), organizations(owner_user_id), organizations(status)
- RLS: ENABLED + admin/operator policies
- FUNCTIONS: none
- BACKWARD_COMPATIBILITY: fully additive; no existing table touched
- RISK: LOW

### P3B2 — contacts + sites
- TABLES: organization_contacts, organization_sites
- COLUMNS: as in §8
- FKS: →organizations(CASCADE)
- INDEXES: contacts(email), contacts(organization_id), sites(organization_id), sites(city)
- RLS: ENABLED + admin/operator
- FUNCTIONS: none
- BACKWARD_COMPATIBILITY: additive
- RISK: LOW

### P3B3 — prospects + opportunities + pipeline events
- TABLES: crm_prospects, crm_opportunities, crm_pipeline_events
- COLUMNS: as in §4, §10
- FKS: opportunities.organization_id→organizations, opportunities.contact_id→organization_contacts, opportunities.devis_id→devis (nullable)
- INDEXES: prospects(email,source,organization_id); opportunities(stage,owner_user_id,next_action_at,organization_id)
- RLS: ENABLED + admin/operator
- FUNCTIONS: `crm_transition_opportunity` RPC (SECURITY DEFINER)
- BACKWARD_COMPATIBILITY: additive
- RISK: MEDIUM (RPC state machine logic)

### P3B4 — activities + timeline view
- TABLES: crm_activities
- VIEW: crm_timeline (UNION of activities + pipeline_events + key devis/mission/billing milestones)
- COLUMNS: as in §5
- FKS: →organizations, →organization_contacts, →crm_prospects, →clients, →devis, →missions
- INDEXES: activities(owner_user_id,due_at) WHERE completed_at IS NULL; activities(organization_id,contact_id)
- RLS: ENABLED + admin/operator
- FUNCTIONS: optional `crm_log_activity` RPC; trigger to refresh opportunity.last_contact_at
- BACKWARD_COMPATIBILITY: additive
- RISK: LOW–MEDIUM

### P3B5 — links to clients/devis/missions
- ALTER: add nullable `organization_id` to clients, devis, missions; add nullable `devis_id` + `opportunity_id` + `contact_id` to devis/missions as specified in §11
- FKS: all nullable, ON DELETE SET NULL (never CASCADE onto existing production tables)
- INDEXES: missions(devis_id), missions(organization_id), devis(organization_id), devis(opportunity_id), clients(organization_id)
- RLS: extend existing clients/devis/missions policies to remain unchanged (new columns inherit existing row visibility)
- FUNCTIONS: none
- BACKWARD_COMPATIBILITY: all new columns NULL by default; existing rows/queries untouched
- RISK: MEDIUM (touches production tables — additive only, no type change, no drop)

### P3B6 — indexes / RLS consolidation / functions / conversion + merge RPCs
- INDEXES: all search indexes from §13
- RLS: consolidate CRM policies; verify no anon/client/convoyeur leak
- FUNCTIONS: `crm_convert_prospect`, `crm_merge_organizations`, `crm_bulk_import_prospects`, `crm_duplicate_suggestions`
- BACKWARD_COMPATIBILITY: additive
- RISK: MEDIUM (RPC logic + dedup)

Each migration is independently reversible (DROP TABLE / DROP COLUMN / DROP FUNCTION) and small.

---

## 19. TEST PLAN

No Production E2E. Local + preview DB only.

- Schema: each table/view/FK/RPC created; `\d+` verification.
- FK integrity: insert child without parent → fails; cascade/SET NULL behavior verified.
- RLS: anon/client/convoyeur denied on all CRM tables; admin/operator allowed.
- Admin CRUD: insert/update/delete organizations, contacts, opportunities, activities.
- Unauthorized access: client JWT cannot read other organizations' contacts/activities.
- Duplicate detection: two orgs same SIRET → hard block; similar names → soft suggestion.
- Prospect conversion: convert prospect → clients row created + organization_id set + prospect marked converted (atomic).
- Pipeline transitions: invalid transition (e.g. lost→won) rejected by RPC; valid transition writes event + updates last_contact_at.
- Activities: insert activity with no anchor → CHECK rejects; complete activity → completed_at set; overdue query returns it.
- Search/filter: each filter returns expected rows; indexes used (EXPLAIN).
- Devis linkage: devis with opportunity_id/organization_id; mission created with devis_id; timeline shows both.
- Mission linkage: mission.organization_id populated; revenue-by-segment KPI aggregates correctly.

---

## 20. IMPLEMENTATION ORDER (P3B+)

| Phase | Branch | Files | Migration | Tests | Stop conditions | Merge gate | Prod gate |
|-------|--------|-------|-----------|-------|----------------|------------|-----------|
| P3B1 | feat/p3b1-crm-organizations | supabase/migrations/..._p3b1_organizations.sql | orgs+segments | schema+RLS tests | all tests green; no existing table altered | review + CI green | manual apply on preview, smoke |
| P3B2 | feat/p3b2-crm-contacts-sites | ..._p3b2_contacts_sites.sql | contacts+sites | FK+RLS tests | green | review | smoke |
| P3B3 | feat/p3b3-crm-prospects-pipeline | ..._p3b3_prospects_pipeline.sql | prospects+opportunities+events+transition RPC | transition+RLS tests | green; RPC rejects invalid transitions | review | smoke |
| P3B4 | feat/p3b4-crm-activities-timeline | ..._p3b4_activities_timeline.sql | activities+timeline view | activity+anchor tests | green | review | smoke |
| P3B5 | feat/p3b5-crm-links-existing | ..._p3b5_links_clients_devis_missions.sql | nullable FKs on clients/devis/missions | legacy compatibility tests (existing rows NULL) | green; existing flows unchanged | review + regression | staged prod apply |
| P3B6 | feat/p3b6-crm-indexes-rls-rpc | ..._p3b6_indexes_rls_rpc.sql | indexes+RLS consolidation+conversion/merge/import RPCs | dedup+conversion+merge tests | green; full CRM test suite passes | review | staged prod |

Stop conditions per phase: any test red, any existing-flow regression, any RLS leak → stop, fix before merge.
Merge gate: CI green + code review + no Production mutation in branch.
Prod gate: apply on preview DB → smoke CRM admin screens → staged production apply with rollback plan (each migration reversible).

---

## STRICT PROHIBITIONS (this phase)
```
CODE_CHANGE=NO
MIGRATION_CREATE=NO
MIGRATION_APPLY=NO
DB_WRITE=NO
PUSH=NO
PR_CREATE=NO
MERGE=NO
DEPLOYMENT=NO
SECRET_CHANGE=NO
CRON_CHANGE=NO
INFRA_CHANGE=NO
```

---

## FINAL REPORT

```
==================================================
P3A — CRM ARCHITECTURE REPORT
==================================================

P3A_RESULT=PASS

MAIN_SHA=6817a55b60d86857f8421a540af0a8044bea913d
WORKTREE_CLEAN=YES

EXISTING_CLIENT_MODEL=clients table (uuid PK) is the primary customer AND admin identity store (role='admin'); holds B2B fields (siret,tva_intra,entreprise,is_pro); linked to auth.users via auth_user_id; FK target of missions/billing_records/support_tickets/vehicules. No organization/contact/site/prospect/pipeline/activity tables exist.
RECOMMENDED_CLIENT_STRATEGY=B — clients remain primary person/customer entity; organizations added as optional parent (clients.organization_id nullable); no destructive change; full backward compatibility.

ORGANIZATION_MODEL=public.organizations (generalized, single table) + organization_segments (many-to-many segment tags: concession/garage/rental/auction/notary/fleet/leasing/dealer/logistics/other). Fields: legal_name, trade_name, siret(UNIQUE soft), siren, vat_number, organization_type, status, website, email, phone, billing_email, billing_address, notes, source, owner_user_id.
CONTACT_MODEL=public.organization_contacts (organization_id FK, first_name, last_name, role, email, phone, mobile, preferred_channel, decision_maker, active, optional client_id link to clients).
SITE_MODEL=public.organization_sites (organization_id FK, name, address, city, postal_code, country, phone, site_type, active).

PROSPECT_MODEL=public.crm_prospects (lead pre-org; source/source_detail/campaign/imported_at/external_reference; converts to clients + optional organization).
PIPELINE_MODEL=public.crm_opportunities (stage text CHECK: lead/qualified/contacted/meeting/quote_requested/quote_sent/negotiating/won/lost/dormant; owner_user_id; estimated_value; next_action/next_action_at; last_contact_at) + crm_pipeline_events (append-only audit, mirrors billing_events). Transitions via SECURITY DEFINER RPC crm_transition_opportunity.
ACTIVITY_MODEL=public.crm_activities (call/email/meeting/visit/note/follow_up/quote/task/reminder; anchored to ≥1 of org/contact/prospect/client/devis/mission; owner_user_id; due_at; completed_at; outcome; notes). DB-persistent, not frontend state.
TIMELINE_MODEL=crm_timeline VIEW (UNION of activities + pipeline_events + devis/mission/billing milestones) — unified feed without merging mutable activities with immutable audit.

ORGANIZATION_SEGMENTS=many-to-many (organization_segments join) — supports multi-segment orgs (garage+dealer, rental+fleet).
DUPLICATE_STRATEGY=hard UNIQUE on organizations.siret (non-null); soft detection RPC on normalized name/siret/email/phone/address; admin merge RPC crm_merge_organizations (reassign FKs, source→inactive, audited, no hard delete).

CRM_TO_DEVIS_FLOW=prospect→org/contact→opportunity(quote_requested)→devis(devis.opportunity_id+organization_id+contact_id FKs, status=sent)→accepted.
CRM_TO_MISSION_FLOW=accepted devis→mission(missions.devis_id NEW FK + organization_id FK + client_id FK); snapshots kept for legal/audit; billing via existing billing_records(mission_id).

ADMIN_UI_STRUCTURE=new CRM nav group: Dashboard commercial / Prospects / Organisations / Contacts / Pipeline / Relances-tâches / Activités / Historique. KPIs: new leads, qualified, quotes sent, conversion rate, won/lost, pipeline value, overdue follow-ups, revenue by client/segment, repeat clients. Existing sections enriched, not replaced.

RLS_MODEL=P3 admin+operator only. anon=NO, client=NO(browse), convoyeur=NO. All CRM tables RLS ENABLED with is_admin() OR is_operator() policies. Elevated ops via SECURITY DEFINER RPCs (service_role). Future 'commercial' role designed, not enabled in P3B.
API_MODEL=hybrid: direct Supabase CRUD (RLS-gated) for orgs/contacts/sites/prospects/activities; SECURITY DEFINER RPCs for prospect conversion, pipeline transitions, merge duplicates, bulk import. No Cloudflare functions for CRM CRUD.

GDPR_NOTES=personal data in contacts/prospects (name/email/phone); business data in orgs (siret/vat). Free-text notes risk mitigated by RLS (no public exposure). Retention/anonymization RPCs deferred (3y stale prospects) with legal validation. Auditability via crm_pipeline_events + activity owner/timestamps. Export future.

PROPOSED_MIGRATIONS=P3B1 organizations+segments | P3B2 contacts+sites | P3B3 prospects+opportunities+pipeline_events+transition RPC | P3B4 activities+timeline view | P3B5 nullable FKs on clients/devis/missions (additive) | P3B6 indexes+RLS consolidation+conversion/merge/import RPCs. All additive, small, independently reversible.

TEST_PLAN=schema/FK/RLS integrity; admin CRUD; unauthorized access (client/convoyeur denied); duplicate detection (hard+soft); prospect conversion (atomic); pipeline transitions (invalid rejected); activities (anchor CHECK, overdue); search/filter+indexes; devis linkage; mission linkage; revenue-by-segment aggregation. Local+preview only, no Production E2E.

P3B_IMPLEMENTATION_ORDER=P3B1 orgs → P3B2 contacts/sites → P3B3 prospects/pipeline/RPC → P3B4 activities/timeline → P3B5 links to clients/devis/missions (additive nullable FKs) → P3B6 indexes/RLS/RPCs. Per-phase stop on red test/regression/RLS leak; merge gate = CI+review; prod gate = preview smoke → staged apply with rollback.

BLOCKERS=none identified. Existing clients/auth/RLS model supports additive CRM layer without destructive change.

CODE_CHANGE=NO
MIGRATION=NO
PROD_WRITE=NO
PUSH=NO
DEPLOYMENT=NO

P3A_RESULT=PASS
```
