# P3A1 — CRM ARCHITECTURE HARDENING / PRE-IMPLEMENTATION GATE

> Hardening of P3A. No migration, no code, no DB write, no push, no commit.
> The P3A report (docs/P3A_CRM_ARCHITECTURE_REPORT.md) is corrected in place where noted; not committed.

---

## 1. WORKTREE TRUTH

```
$ git status --short
?? docs/P3A_CRM_ARCHITECTURE_REPORT.md
```

The P3A report file is **untracked** (not staged, not committed).
```
WORKTREE_CLEAN=NO
```
A worktree with an untracked deliverable file is NOT clean. The file is intentionally left uncommitted pending explicit authorization.

---

## 2. FUTURE B2B IDENTITY MODEL

### Decision: `clients.organization_id` is a soft data link, NOT an authorization mechanism.

`clients.organization_id` (nullable, added in P3B5) only answers "which organization is this customer profile associated with?" for commercial reporting and timeline grouping. It grants NO B2B access. B2B portal authorization is a separate, future concern handled by `organization_memberships`.

### Proposed future entity: `public.organization_memberships` (NOT created in P3)

```
id              uuid PK
organization_id uuid NOT NULL FK→organizations(CASCADE)
auth_user_id    uuid NOT NULL FK→auth.users(ON DELETE CASCADE)
role            text NOT NULL CHECK IN ('owner','admin','manager','requester','finance','viewer')
site_id         uuid NULL FK→organization_sites(SET NULL)
status          text NOT NULL DEFAULT 'invited' CHECK IN ('invited','active','suspended','revoked')
permissions     jsonb NULL   -- optional fine-grained overrides; NULL = role defaults
invited_at      timestamptz NOT NULL DEFAULT now()
accepted_at     timestamptz
created_at      timestamptz NOT NULL DEFAULT now()
updated_at      timestamptz NOT NULL DEFAULT now()
UNIQUE (organization_id, auth_user_id)
```

### auth_user_id reference decision
`auth_user_id` references `auth.users(id)` **directly** — consistent with the project's current conventions:
- `user_roles.user_id` → `auth.users(id) ON DELETE CASCADE`
- `internal_operators.user_id` → `auth.users(id) ON DELETE CASCADE`

The project does NOT use an application-profile indirection table for authorization identities; `auth.users` is the identity root and `user_roles`/`internal_operators`/`clients.auth_user_id` are the profile layers. `organization_memberships` follows the same pattern: `auth_user_id → auth.users` for identity, with the membership row itself being the profile/authorization layer.

### Relationship to existing `clients`
- A B2B user may or may not have a `clients` row. `clients` is the *customer* profile (orders quotes/missions); `organization_memberships` is the *B2B portal access* profile. They are orthogonal.
- A single `auth.users` identity can have: a `clients` row (customer profile) + an `organization_memberships` row (B2B portal access) + a `user_roles` row (internal admin/operator). These coexist without conflict.
- `clients.organization_id` and `organization_memberships.organization_id` can point to the same org; neither implies the other's authorization.

### P4 readiness
P3 schema adds `organization_memberships` as an empty, RLS-locked, admin-only table (or defers it entirely to P4). Either way, P3 does NOT force a P4 schema rework because:
- `clients.organization_id` is nullable and non-authoritative.
- `organization_memberships` is additive and self-contained.
- No existing table's structure or RLS depends on B2B membership.

```
B2B_IDENTITY_MODEL=public.organization_memberships (future) — auth_user_id→auth.users(CASCADE), role CHECK(owner/admin/manager/requester/finance/viewer), status(invited/active/suspended/revoked), optional site_id, permissions jsonb. Orthogonal to clients; clients.organization_id is a data link only, not authorization.
CLIENTS_USED_AS_B2B_AUTH_STORE=NO
P4_SCHEMA_REWORK_REQUIRED_LATER=NO
```

---

## 3. CLIENTS TABLE OVERLOAD

### Current uses of `clients.role`
Audited from schema + migrations:

| `role` value | Meaning | Safeguard |
|---|---|---|
| `'client'` (default) | Actual customer / authenticated client profile | Normal customer flow |
| `'admin'` (legacy) | Internal admin identity | Protected by `guard_clients_privileged_fields` trigger (non-admin cannot set role='admin'); synced to `user_roles` by `sync_user_roles_on_client_role` trigger |
| NULL / other | Legacy or edge records | Treated as non-admin, non-privileged |

`clients.role` is NOT a free-text field in practice: the guard trigger blocks non-admins from changing it, and the sync trigger keeps `user_roles` consistent. Modern admin authorization flows through `user_roles` (role='admin' or 'operator'); `clients.role='admin'` is the legacy fallback still honored by `is_admin()`.

### Safeguards required before adding `clients.organization_id`

1. **Admin rows must not become CRM customers.**
   - CRM client-facing queries (e.g. "revenue by client", "repeat clients") MUST filter `clients.role IS DISTINCT FROM 'admin'` (or equivalently exclude rows where `is_admin()` would be true for that row).
   - The CRM `clients.organization_id` column is set ONLY by admin/operator action (RLS + RPC), never by self-service client update. The existing `clients_update_own_strict` policy allows a client to update their own row — it must NOT permit setting `organization_id`. Either:
     - (a) add `organization_id` to the `guard_clients_privileged_fields` trigger's protected columns (preferred — consistent with existing pattern), or
     - (b) add a CHECK in the update policy. Option (a) is cleaner and reuses the proven guard.

2. **CRM client queries must not include internal identities.**
   - All CRM views/RPCs that aggregate "clients" must apply `WHERE role IS DISTINCT FROM 'admin'` (and optionally `banned = false`).
   - The `crm_timeline` view, when surfacing client-linked events, must join `clients` with the same exclusion.
   - A helper view `crm_customers` (view over `clients WHERE role IS DISTINCT FROM 'admin'`) can centralize this filter so no CRM query forgets it.

3. **Organization linkage remains nullable/backward-compatible.**
   - `clients.organization_id` is nullable, default NULL, FK→organizations `ON DELETE SET NULL`.
   - Existing rows: NULL → behave exactly as today. No backfill.
   - No NOT NULL constraint ever forced on existing rows.

### Proposed invariants (enforced in P3B5/P3B6)
- `organization_id` added to `guard_clients_privileged_fields` protected columns (non-admin cannot set it).
- CRM customer-scoped queries use `role IS DISTINCT FROM 'admin'`.
- `clients.organization_id` FK `ON DELETE SET NULL` (never CASCADE — deleting an org must not delete customer profiles).

```
CLIENT_STRATEGY=B (unchanged) — clients remain primary person/customer entity; organizations optional nullable parent.
CLIENTS_OVERLOAD_SAFEGUARDS=
  1. guard_clients_privileged_fields trigger extended to protect organization_id (non-admin cannot set it);
  2. CRM customer queries filter role IS DISTINCT FROM 'admin' (centralized via crm_customers view);
  3. clients.organization_id nullable, default NULL, FK ON DELETE SET NULL, no backfill;
  4. admin/operator-only writes to organization_id via RLS.
```

---

## 4. ORGANIZATION MODEL FINALIZATION

### Confirmed tables and cardinalities

| Table | Cardinality to organizations | Purpose |
|---|---|---|
| `organizations` | — (root) | One real-world company/entity |
| `organization_segments` | N:1 (segment catalog/enum values) | Lookup of allowed segment values (static seed) |
| `organization_segment_links` | N:M join | One org ↔ many segments; one segment ↔ many orgs |
| `organization_sites` | N:1 (sites belong to one org) | Physical locations |
| `organization_contacts` | N:1 (contacts belong to one org) | People at an org |

### Contacts: generic vs organization-scoped
**Decision: `organization_contacts` is organization-scoped (organization_id NOT NULL).**

Rationale:
- A contact without an organization is a *prospect person*, handled by `crm_prospects` (which can hold a standalone person before any org exists).
- Once an organization exists, every contact belongs to exactly one organization. A person who is a contact at two companies gets two contact rows (one per org) — this is correct because their role/phone/decision-maker status may differ per company.
- `organization_contacts.client_id` (nullable) optionally links a contact to a `clients` row if that person is also a registered customer.
- A generic free-floating `contacts` table would require nullable organization_id everywhere and complicate RLS ("can I see this contact? only if its org is... null?"). Organization-scoped is simpler and more secure.

### Hard unique keys
- `organizations.siret` — **partial UNIQUE index** `WHERE siret IS NOT NULL AND btrim(siret) <> ''`. SIRET unique only where present and non-empty. Organizations without a SIRET (e.g. informal partners, prospects promoted early) are NOT forced to invent one.
- `organization_memberships` (future) — `UNIQUE(organization_id, auth_user_id)`.

### Soft duplicate keys (detection, not constraints)
- normalized `legal_name` (lowercase, unaccented, trimmed, suffix-stripped: SAS/SARL/SASU/SA/EURL)
- `email` (org email)
- `phone` (normalized digits)
- normalized `billing_address`
- `siren` (first 9 digits of siret; softer than siret)

### Normalized fields
- `legal_name` trimmed; `trade_name` trimmed.
- `siret` digits-only, 14 chars validated where present (`CHECK (siret IS NULL OR (siret ~ '^\d{14}$')`).
- `vat_number` normalized (strip spaces, uppercase).
- `email` lowercased.
- `phone` stored as-is but normalized for matching in the dedup RPC.

```
ORGANIZATION_MODEL=public.organizations (legal_name, trade_name, siret partial-UNIQUE where non-empty, siren, vat_number, organization_type, status, website, email, phone, billing_email, billing_address, notes, source, owner_user_id). Generalized single table; no per-partner-type tables.
CONTACT_MODEL=public.organization_contacts (organization_id NOT NULL FK CASCADE; first_name, last_name, role, email, phone, mobile, preferred_channel, decision_maker, active, client_id nullable→clients). Organization-scoped; standalone persons live in crm_prospects.
SITE_MODEL=public.organization_sites (organization_id FK CASCADE; name, address, city, postal_code, country, phone, site_type, active).
SEGMENT_MODEL=organization_segments (static lookup of allowed values) + organization_segment_links (N:M join: organization_id, segment; PK(organization_id, segment)). Supports multi-segment orgs.
HARD_UNIQUE_KEYS=organizations.siret partial UNIQUE WHERE non-empty; organization_memberships(organization_id, auth_user_id) [future].
SOFT_DUPLICATE_KEYS=normalized legal_name, email, phone, billing_address, siren.
NORMALIZED_FIELDS=legal_name/trade_name trimmed; siret digits 14; vat_number uppercased; email lowercased.
```

---

## 5. PROSPECT / OPPORTUNITY MODEL

### Conceptual separation (confirmed)
- **organization / contact = WHO** (the real-world entity and people)
- **opportunity = the commercial deal** (one company can have many opportunities over time)
- **pipeline stage = opportunity state** (a column on opportunity, not a separate table)
- **activity = interaction/task** (calls, meetings, follow-ups anchored to any CRM entity)

### Prospect vs Opportunity: reduce to ONE commercial object
**Decision: `crm_opportunities` is the single commercial object. A "prospect" is an opportunity in its earliest stage (`stage='lead'`), optionally linked to a loose contact/person before an organization is created.**

A separate `crm_prospects` table that duplicates (name, email, phone, organization_id, source) would represent the same commercial object as an early-stage opportunity — redundant and prone to divergence.

### Revised model
- `crm_opportunities` carries a `stage` that starts at `'lead'` (the prospect stage).
- For a lead with no organization yet, `organization_id` is NULL and lightweight person fields (`lead_first_name`, `lead_last_name`, `lead_email`, `lead_phone`) are stored on the opportunity. When the lead qualifies and an organization/contact is created, these are migrated to `organization_contacts` and the opportunity's `organization_id`/`contact_id` are set; the lead_* fields are cleared (or kept as a snapshot).
- `source`, `source_detail`, `campaign`, `imported_at`, `external_reference` live on `crm_opportunities` (sourcing is a property of the lead/opportunity, not a separate entity).
- Conversion "prospect → client" becomes "opportunity stage → won" + create/link `clients` row + set `clients.organization_id`.

This eliminates the `crm_prospects` table from the P3A design. One table, one commercial object, stage-driven lifecycle.

```
OPPORTUNITY_MODEL=public.crm_opportunities — single commercial object. stage starts 'lead' (prospect). Early leads carry lead_first_name/lead_email/lead_phone (nullable) when no organization exists yet. source/source_detail/campaign/imported_at/external_reference on the opportunity. One organization → many opportunities over time. Conversion = stage→won + create/link clients row.
PIPELINE_MODEL=stage text CHECK on crm_opportunities (lead/qualified/contacted/meeting/quote_requested/quote_sent/negotiating/won/lost/dormant). owner_user_id, estimated_value, next_action, next_action_at, last_contact_at. NOT a separate table.
PIPELINE_EVENT_MODEL=public.crm_pipeline_events — append-only immutable audit of stage transitions (see §6).
ACTIVITY_MODEL=public.crm_activities — interactions/tasks anchored to ≥1 CRM entity (unchanged from P3A).
TIMELINE_MODEL=crm_timeline VIEW — stable fields union of activities + pipeline_events + devis/mission/billing milestones (see §7).
```

---

## 6. PIPELINE EVENT IMMUTABILITY

### `crm_pipeline_events` design
```
id              uuid PK DEFAULT gen_random_uuid()
opportunity_id  uuid NOT NULL FK→crm_opportunities(RESTRICT)
from_stage      text        -- nullable for initial creation
to_stage        text NOT NULL
reason          text        -- free text (lost reason, note)
actor_user_id   uuid        -- auth.uid() of the caller
actor_role      text        -- 'admin' | 'operator' (captured at event time)
metadata        jsonb DEFAULT '{}'
created_at      timestamptz NOT NULL DEFAULT now()
```

### Immutability enforcement
- **INSERT**: controlled — ONLY via the `crm_transition_opportunity` RPC (SECURITY DEFINER). Direct client INSERT blocked by RLS (no INSERT policy for authenticated/anon; only the RPC via service_role writes).
- **UPDATE**: NO. RLS: no UPDATE policy. Plus a trigger `BEFORE UPDATE ON crm_pipeline_events` that always raises `cannot update immutable event` (defense-in-depth, since service_role bypasses RLS).
- **DELETE**: NO. RLS: no DELETE policy. Plus a `BEFORE DELETE` trigger that always raises (defense-in-depth).

### Transition RPC: `crm_transition_opportunity`
```
SECURITY_DEFINER_REQUIRED=YES
```
Requirements (all enforced):
- `SET search_path = ''` (explicit, fixed).
- Explicit authorization check inside the function body: `IF NOT (public.is_admin() OR public.is_operator()) THEN RAISE 'not authorized' USING ERRCODE='42501'; END IF;`
- Transition validation: a static allowed-transitions map (e.g. lead→qualified, qualified→contacted, ..., negotiating→won, negotiating→lost, any→dormant, dormant→lead). Invalid transitions raise `invalid_transition`.
- Captures `from_stage` (current stage before update), `to_stage` (target), `actor_user_id = auth.uid()`, `actor_role` (resolved from is_admin/is_operator), `reason`.
- Atomic: UPDATE opportunity.stage + INSERT pipeline_event in one transaction. If either fails, both roll back.
- `GRANT EXECUTE TO authenticated; REVOKE EXECUTE FROM anon;` — only authenticated users can call; the function re-checks admin/operator internally (RLS is not the gate for SECURITY DEFINER; the explicit check is).

### Why not generic elevated CRUD RPC
Generic "crm_admin_write" RPCs that wrap arbitrary INSERT/UPDATE are an abuse risk: they bypass RLS and trust the caller's payload for any column. The transition RPC is narrowly scoped to one operation with a validated state machine. This is the only elevated write path for pipeline state.

```
PIPELINE_EVENT_MODEL=public.crm_pipeline_events (append-only, immutable). INSERT only via crm_transition_opportunity RPC; UPDATE/DELETE blocked by RLS + BEFORE trigger. RPC: SECURITY DEFINER, search_path='', explicit is_admin()/is_operator() check, allowed-transition map, captures from_stage/to_stage/actor_user_id/actor_role/reason, atomic update+event.
```

---

## 7. TIMELINE VIEW

### `crm_timeline` VIEW — stable fields

| Field | Type | Source |
|---|---|---|
| `event_id` | text | composite: `source_prefix || ':' || source_pk` (e.g. `'activity:' || id::text`, `'pipeline:' || id::text`, `'devis:' || id::text`) — globally unique across sources |
| `event_source` | text | `'activity'`, `'pipeline'`, `'devis'`, `'mission'`, `'billing'` |
| `event_type` | text | source-specific (e.g. `'call'`, `'stage_changed'`, `'devis_accepted'`, `'mission_completed'`, `'invoice_issued'`) |
| `organization_id` | uuid | resolved per source (activity.org, opportunity.org, devis.org, mission.org) |
| `contact_id` | uuid | nullable |
| `opportunity_id` | uuid | nullable |
| `devis_id` | uuid | nullable |
| `mission_id` | uuid | nullable |
| `billing_record_id` | uuid | nullable |
| `actor_user_id` | uuid | nullable (activity.owner, pipeline.actor, etc.) |
| `occurred_at` | timestamptz | the event timestamp (activity.created_at/completed_at, pipeline.created_at, devis/mission/billing timestamps) |
| `summary` | text | human-readable one-liner (e.g. "Appel téléphonique — issue prix") |
| `metadata` | jsonb | source-specific payload |

### Stable unique event IDs
`event_id` is deterministic: `event_source || ':' || source_table_pk::text`. Since each source table has a uuid PK, the composite is globally unique. No collision across sources.

### Deterministic ordering
`ORDER BY occurred_at DESC NULLS LAST, event_id DESC` — occurred_at is the primary sort; event_id is the tiebreaker for same-timestamp events (deterministic, stable).

### Query/index strategy
- The view is a UNION ALL of 5 sub-selects. Each sub-select filters to relevant rows and projects the stable columns.
- Indexes on the underlying tables support the view:
  - `crm_activities(organization_id, occurred_at DESC)` — but occurred_at = COALESCE(completed_at, created_at); to index effectively, store a generated `occurred_at` column on activities OR index `(organization_id, created_at)` and accept created_at as occurred_at for activities. **Decision: use `created_at` as `occurred_at` for activities** (simpler, indexable); `completed_at` is a separate field shown in metadata.
  - `crm_pipeline_events(opportunity_id, created_at DESC)` and a join to `crm_opportunities(organization_id)`.
  - `devis(organization_id, created_at)` (added in P3B5).
  - `missions(organization_id, created_at)` (added in P3B5).
  - `billing_records(mission_id)` + join to `missions(organization_id)`.
- For a per-organization timeline query: `WHERE organization_id = $1 ORDER BY occurred_at DESC NULLS LAST, event_id DESC LIMIT 50`. The planner pushes the org filter into each sub-select; the indexes above make each sub-select cheap.

### No leakage beyond RLS
- The view is created with `security_invoker = true` (consistent with the project's `convoyeurs_public` view pattern). It inherits the RLS of every underlying table.
- An anon/client/convoyeur querying `crm_timeline` sees only rows their RLS allows on each source table — which for CRM tables is NONE (admin/operator only). So they see only the devis/mission/billing rows they already have access to, nothing new.
- The view adds NO new grants; it only UNIONs existing RLS-governed rows.

```
TIMELINE_MODEL=crm_timeline VIEW (security_invoker=true). Stable fields: event_id (source:pk, globally unique), event_source, event_type, organization_id, contact_id, opportunity_id, devis_id, mission_id, billing_record_id, actor_user_id, occurred_at, summary, metadata. Ordering: occurred_at DESC NULLS LAST, event_id DESC. Indexes on source tables (org_id, created_at). No leakage: inherits RLS of all underlying tables; CRM tables admin/operator-only so non-internal users see nothing new.
```

---

## 8. DEVIS / MISSION TRACEABILITY

### Recommended additive FKs (minimal set)

| Column | Table | FK target | Nullable | ON DELETE | Backfill |
|---|---|---|---|---|---|
| `devis.organization_id` | devis | organizations(id) | YES | SET NULL | NO — existing rows stay NULL |
| `devis.contact_id` | devis | organization_contacts(id) | YES | SET NULL | NO |
| `devis.opportunity_id` | devis | crm_opportunities(id) | YES | SET NULL | NO |
| `missions.devis_id` | missions | devis(id) | YES | SET NULL | NO |
| `missions.organization_id` | missions | organizations(id) | YES | SET NULL | NO |

### Columns NOT added (minimize duplication)
- `missions.contact_id` — NOT added. The contact is reachable via `devis.contact_id` (if devis_id is set) or via `clients.organization_id → organization_contacts`. Adding it to missions duplicates the link and risks divergence.
- `missions.opportunity_id` — NOT added. Reachable via `missions.devis_id → devis.opportunity_id`. The mission's commercial lineage is devis→opportunity; no need to denormalize.
- `devis.client_id` FK enforcement — the existing `devis.client_id` has NO FK in the schema. **Do NOT add the FK in P3B5** (risk: existing devis rows may reference deleted/nonexistent clients; adding a FK could fail or require cleanup). Leave as-is; the CRM link is via `devis.opportunity_id`/`organization_id`.

### Historical snapshots preserved
- `devis.client_nom`, `devis.client_prenom`, `devis.client_email` — KEPT (legal document: a quote must remain readable as issued).
- `missions.client_nom`, `missions.client_email`, `missions.client_telephone` — KEPT (legal/audit).
- The new FKs are *links*, not replacements. The snapshot columns remain the legal record; the FKs add traceability.

### Existing production rows
- All new columns are nullable, default NULL. Existing rows: NULL → unchanged behavior.
- No backfill. Existing devis/missions have no organization/devis link; they continue to work as today. New records created via the CRM flow get the links.

### Migration/backfill policy
- P3B5 migration: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` for each column; add FKs with `ON DELETE SET NULL`. No data movement.
- No backfill script. A future optional admin tool could retroactively link existing devis→missions by matching `reference`/`client_email`, but that is out of P3B scope and requires manual review.

```
DEVIS_LINK_MODEL=devis.organization_id (nullable, SET NULL), devis.contact_id (nullable, SET NULL), devis.opportunity_id (nullable, SET NULL). All additive, no backfill. Snapshots (client_nom/prenom/email) kept for legal record.
MISSION_LINK_MODEL=missions.devis_id (nullable, SET NULL) — closes the current implicit frontend link. missions.organization_id (nullable, SET NULL). NOT added: missions.contact_id, missions.opportunity_id (reachable via devis). No backfill; existing rows NULL.
```

---

## 9. RLS MODEL HARDENING

### Verified project role implementation
- `is_admin()` — `user_roles.role='admin'` OR legacy `clients.role='admin'`. SECURITY DEFINER, `search_path=''`.
- `is_operator()` — `user_roles.role='operator'` AND `internal_operators.active=true`. SECURITY DEFINER, `search_path=''`.
- `is_internal_user()` — `is_admin() OR is_operator()`. SECURITY DEFINER, `search_path=''`. Established pattern used across 20+ migrations for internal-staff access.
- The operator model is **safe and mature**: `is_operator()` requires both a `user_roles` row AND an active `internal_operators` row (two-factor: role assignment + active profile). Deactivation is possible by setting `internal_operators.active=false`.

### P3 CRM access decision
- **anon = NO**
- **convoyeur = NO**
- **client = NO** (in P3; future B2B via `organization_memberships`, not via client role)
- **admin = YES** (via `is_admin()`)
- **internal_operator = YES** (via `is_operator()`) — the operator model safely supports it (active flag, role separation, no client/convoyeur collision after P4.2 cleanup).

**Predicate for all CRM tables: `public.is_internal_user()`** (i.e. `is_admin() OR is_operator()`). This reuses the established project pattern and avoids inventing a new `is_crm_user()`.

### Per-table RLS

| Table | SELECT | INSERT | UPDATE | DELETE | Predicate |
|---|---|---|---|---|---|
| `organizations` | `is_internal_user()` | `is_internal_user()` | `is_internal_user()` | `is_internal_user()` (soft — set status inactive, see §16) | admin+operator |
| `organization_segments` | `is_internal_user()` | NO (seed only via service_role) | NO | NO | static lookup |
| `organization_segment_links` | `is_internal_user()` | `is_internal_user()` | NO | `is_internal_user()` | admin+operator link/unlink |
| `organization_sites` | `is_internal_user()` | `is_internal_user()` | `is_internal_user()` | `is_internal_user()` | admin+operator |
| `organization_contacts` | `is_internal_user()` | `is_internal_user()` | `is_internal_user()` | `is_internal_user()` (or soft-delete via active=false) | admin+operator |
| `crm_opportunities` | `is_internal_user()` | `is_internal_user()` | `is_internal_user()` (but stage only via RPC — see below) | `is_internal_user()` | admin+operator |
| `crm_pipeline_events` | `is_internal_user()` | NO (RPC only) | NO | NO | immutable audit |
| `crm_activities` | `is_internal_user()` | `is_internal_user()` | `is_internal_user()` (until completed) | `is_internal_user()` | admin+operator |
| `crm_timeline` (view) | `is_internal_user()` (inherits) | N/A | N/A | N/A | view, security_invoker |

### Stage update restriction on `crm_opportunities`
Direct UPDATE of `stage` via RLS is technically allowed for `is_internal_user()`, but the intended path is the `crm_transition_opportunity` RPC (which validates transitions and logs events). To enforce this without breaking other column updates:
- RLS allows UPDATE for `is_internal_user()` (so owner, estimated_value, next_action, etc. can be edited directly).
- A `BEFORE UPDATE OF stage` trigger on `crm_opportunities` raises unless the update comes from the RPC (detected via a session-level flag `current_setting('app.crm_transition', true)` set by the RPC, or by checking `current_user` / a dedicated role). This is the established pattern in the codebase (triggers guard privileged fields on `clients`).
- Simpler alternative: the trigger allows stage change only if `auth.uid()` matches a service_role context OR if a transition marker is set. The RPC sets the marker.

```
RLS_MODEL=P3 admin+operator only. Predicate: public.is_internal_user() (= is_admin() OR is_operator(), proven pattern). anon=NO, convoyeur=NO, client=NO. All CRM tables RLS ENABLED. crm_pipeline_events: INSERT via RPC only, UPDATE/DELETE blocked by RLS+trigger. crm_opportunities.stage: direct UPDATE blocked by trigger except via transition RPC (session marker). crm_timeline: security_invoker view, inherits RLS, no new grants. No commercial role invented in P3.
```

---

## 10. SECURITY DEFINER RPC RULES

### Candidate RPC classification

| RPC | SECURITY_DEFINER_REQUIRED | WHY | ABUSE_RISK | AUTHORIZATION_CHECK |
|---|---|---|---|---|
| `crm_transition_opportunity` | **YES** | Atomic UPDATE opportunity.stage + INSERT immutable pipeline_event + validate allowed transitions. Needs to bypass RLS to write the immutable event table (which has no INSERT policy). | LOW — narrowly scoped, validated state machine, single table pair. | `IF NOT (is_admin() OR is_operator()) THEN RAISE 'not authorized'` |
| `crm_convert_opportunity_to_client` | **YES** | Atomic: create/link `clients` row + set `clients.organization_id` + set opportunity.stage='won' + log pipeline event + create activity. Cross-table atomic write touching `clients` (guarded table). | MEDIUM — touches `clients`; must respect `guard_clients_privileged_fields` (set organization_id which is protected). RPC runs as service_role so the trigger allows it. | `IF NOT (is_admin() OR is_operator()) THEN RAISE` |
| `crm_merge_organizations` | **YES** | Atomic reassignment of all FKs (contacts, sites, devis, missions, clients.organization_id, opportunities, activities) from source→target + set source inactive + audit. Destructive-ish, cross-table. | MEDIUM-HIGH — bulk reassign; must be idempotent and audited. | `IF NOT is_admin() THEN RAISE` (admin-only — merge is destructive, operators should not merge) |
| `crm_bulk_import_opportunities` | **YES** (but constrained) | Bulk insert leads with dedup. Needs service_role to write + run dedup queries across orgs. | HIGH if unconstrained. Mitigations: row limit (e.g. max 500 per call), strict column whitelist (no organization_id injection — orgs must pre-exist or be created via separate admin step), source/imported_at stamped, returns per-row success/failure. | `IF NOT (is_admin() OR is_operator()) THEN RAISE`; row limit enforced; payload schema-validated. |

### Rules for all SECURITY DEFINER RPCs
1. `SET search_path = ''` — always.
2. Explicit `is_admin()` / `is_operator()` check as the FIRST statement in the body (never rely solely on RLS/GRANT for SECURITY DEFINER).
3. `GRANT EXECUTE TO authenticated; REVOKE EXECUTE FROM anon, PUBLIC;`
4. No generic "write any column" — each RPC has a fixed parameter list and column whitelist.
5. Bulk import: row limit + per-row validation + no service-level blanket powers (the RPC only inserts into `crm_opportunities` with a fixed column set; it does not expose arbitrary SQL).
6. All elevated writes that touch immutable tables (pipeline_events) go through the transition RPC, not through a generic write RPC.

### RPCs that do NOT need SECURITY DEFINER
- Standard CRUD on organizations/contacts/sites/activities/opportunities (non-stage columns) — direct Supabase client writes under RLS (`is_internal_user()`). No RPC needed.
- `crm_duplicate_suggestions` (read-only dedup query) — can be a STABLE function with `security_invoker` or just a view; no elevated write.

```
SECURITY_DEFINER_RPC_MODEL=
  crm_transition_opportunity: YES (atomic stage+event, validated transitions, admin/operator)
  crm_convert_opportunity_to_client: YES (atomic cross-table, touches guarded clients, admin/operator)
  crm_merge_organizations: YES (bulk FK reassign, admin-only, audited)
  crm_bulk_import_opportunities: YES (constrained: row limit, column whitelist, admin/operator)
  All: search_path='', explicit auth check first, GRANT authenticated/REVOKE anon, no generic write RPCs.
  Standard CRUD: direct RLS-gated writes, no RPC.
```

---

## 11. P3B MIGRATION SPLIT (final)

### Dependency-ordered sequence

| Phase | Branch | Migration | DEPENDS_ON | PROD_RISK | ROLLBACK_COMPLEXITY | DATA_BACKFILL | TEST_GATE |
|---|---|---|---|---|---|---|---|
| **P3B1** | `feat/p3b1-crm-organizations` | `..._p3b1_organizations_segments.sql` | none | LOW | LOW (DROP TABLE) | none | schema + RLS: anon denied, admin/operator allowed; segments seed correct |
| **P3B2** | `feat/p3b2-crm-contacts-sites` | `..._p3b2_contacts_sites.sql` | P3B1 | LOW | LOW (DROP TABLE) | none | FK integrity (contact/site without org → fail); RLS |
| **P3B3** | `feat/p3b3-crm-opportunities-pipeline` | `..._p3b3_opportunities_pipeline.sql` | P3B1, P3B2 | MEDIUM | MEDIUM (DROP TABLE + DROP FUNCTION) | none | transition RPC: valid/invalid transitions; event immutability (UPDATE/DELETE blocked); RLS |
| **P3B4** | `feat/p3b4-crm-activities-timeline` | `..._p3b4_activities_timeline.sql` | P3B1, P3B2, P3B3 | LOW-MEDIUM | LOW (DROP TABLE + DROP VIEW) | none | activity anchor CHECK (no anchor → fail); timeline view fields stable; RLS no leakage |
| **P3B5** | `feat/p3b5-crm-links-existing` | `..._p3b5_links_clients_devis_missions.sql` | P3B1, P3B3 | MEDIUM | MEDIUM (DROP COLUMN — reversible since nullable, no data) | none (all NULL) | existing rows unchanged; existing flows (devis→mission, clients CRUD) regression-free; guard trigger extended to organization_id |
| **P3B6** | `feat/p3b6-crm-indexes-rls-rpc` | `..._p3b6_indexes_rls_rpc.sql` | P3B1–P3B5 | MEDIUM | LOW (DROP INDEX/FUNCTION) | none | search indexes used (EXPLAIN); conversion RPC atomic; merge RPC admin-only + audited; bulk import row limit enforced |

### Order rationale
- P3B1 before P3B2 (contacts/sites FK→organizations).
- P3B3 after P3B1/P3B2 (opportunities FK→organizations, optionally→contacts).
- P3B4 after P3B3 (activities can anchor to opportunities; timeline includes pipeline events).
- P3B5 after P3B1/P3B3 (links existing tables to organizations/opportunities; needs orgs + opportunities to exist).
- P3B6 last (indexes/RPCs depend on all tables existing; consolidation phase).

Each migration is independently reversible: DROP TABLE/COLUMN/FUNCTION/INDEX/VIEW. No data backfill in any phase — all new columns nullable, all new tables empty.

---

## STRICT PROHIBITIONS (this phase)
```
MIGRATION_CREATE=NO
MIGRATION_APPLY=NO
CODE_CHANGE=NO
DB_WRITE=NO
COMMIT=NO
PUSH=NO
PR_CREATE=NO
MERGE=NO
DEPLOYMENT=NO
SECRET_CHANGE=NO
INFRA_CHANGE=NO
```

The P3A report file was edited in place to reflect the hardened design (prospect→opportunity reduction, organization_memberships future model, timeline field stabilization, RPC rules). It remains uncommitted.

---

## FINAL REPORT

```
==================================================
P3A1 — CRM ARCHITECTURE HARDENING REPORT
==================================================

P3A1_RESULT=PASS

WORKTREE_CLEAN=NO  (docs/P3A_CRM_ARCHITECTURE_REPORT.md untracked; no commit authorized)

CLIENT_STRATEGY=B — clients remain primary person/customer entity; organizations optional nullable parent; no destructive change.
CLIENTS_OVERLOAD_SAFEGUARDS=guard_clients_privileged_fields trigger extended to protect organization_id; CRM customer queries filter role IS DISTINCT FROM 'admin' (centralized via crm_customers view); clients.organization_id nullable/SET NULL/no backfill; admin/operator-only writes.

ORGANIZATION_MODEL=public.organizations (generalized single table; siret partial-UNIQUE where non-empty; no per-partner-type tables).
B2B_IDENTITY_MODEL=public.organization_memberships (future, not in P3) — auth_user_id→auth.users(CASCADE), role CHECK(owner/admin/manager/requester/finance/viewer), status(invited/active/suspended/revoked), site_id nullable, permissions jsonb. Orthogonal to clients; clients.organization_id is data-link only, not authorization.
CLIENTS_USED_AS_B2B_AUTH_STORE=NO

CONTACT_MODEL=public.organization_contacts (organization_id NOT NULL FK CASCADE; first_name, last_name, role, email, phone, mobile, preferred_channel, decision_maker, active, client_id nullable→clients). Organization-scoped; standalone persons are early-stage opportunities (lead_* fields).
SITE_MODEL=public.organization_sites (organization_id FK CASCADE; name, address, city, postal_code, country, phone, site_type, active).
SEGMENT_MODEL=organization_segments (static lookup) + organization_segment_links (N:M join, PK(organization_id, segment)). Supports multi-segment orgs.

OPPORTUNITY_MODEL=public.crm_opportunities — single commercial object; stage starts 'lead' (prospect). Early leads carry lead_first_name/lead_email/lead_phone when no org exists. source/source_detail/campaign/imported_at/external_reference on opportunity. One org → many opportunities over time. crm_prospects table ELIMINATED (reduced into early-stage opportunity).
PIPELINE_MODEL=stage text CHECK on crm_opportunities (lead/qualified/contacted/meeting/quote_requested/quote_sent/negotiating/won/lost/dormornant). owner_user_id, estimated_value, next_action, next_action_at, last_contact_at. Not a separate table.
PIPELINE_EVENT_MODEL=public.crm_pipeline_events — append-only immutable. INSERT only via crm_transition_opportunity RPC; UPDATE/DELETE blocked by RLS + BEFORE trigger. RPC: SECURITY DEFINER, search_path='', explicit is_admin()/is_operator() check, allowed-transition map, captures from_stage/to_stage/actor_user_id/actor_role/reason, atomic.
ACTIVITY_MODEL=public.crm_activities (call/email/meeting/visit/note/follow_up/quote/task/reminder; anchored to ≥1 CRM entity; owner_user_id; due_at; completed_at; outcome; notes). DB-persistent.
TIMELINE_MODEL=crm_timeline VIEW (security_invoker=true). Stable fields: event_id (source:pk, globally unique), event_source, event_type, organization_id, contact_id, opportunity_id, devis_id, mission_id, billing_record_id, actor_user_id, occurred_at, summary, metadata. Ordering: occurred_at DESC NULLS LAST, event_id DESC. Inherits RLS; no leakage; no new grants.

DEVIS_LINK_MODEL=devis.organization_id + devis.contact_id + devis.opportunity_id (all nullable, SET NULL, no backfill). Snapshots kept.
MISSION_LINK_MODEL=missions.devis_id (nullable, SET NULL — closes implicit frontend link) + missions.organization_id (nullable, SET NULL). NOT added: missions.contact_id, missions.opportunity_id (reachable via devis). No backfill.

RLS_MODEL=P3 admin+operator only via public.is_internal_user() (= is_admin() OR is_operator(), proven pattern). anon=NO, convoyeur=NO, client=NO. All CRM tables RLS ENABLED. crm_pipeline_events: INSERT via RPC only, UPDATE/DELETE blocked. crm_opportunities.stage: direct UPDATE blocked by trigger except via transition RPC. crm_timeline: security_invoker view. No commercial role in P3.
SECURITY_DEFINER_RPC_MODEL=crm_transition_opportunity (YES, admin/operator), crm_convert_opportunity_to_client (YES, admin/operator), crm_merge_organizations (YES, admin-only), crm_bulk_import_opportunities (YES, constrained: row limit + column whitelist, admin/operator). All: search_path='', explicit auth check first, GRANT authenticated/REVOKE anon. Standard CRUD: direct RLS, no RPC.

P4_SCHEMA_REWORK_REQUIRED_LATER=NO — P3 additive schema (nullable links, empty new tables, orthogonal memberships) prepares P4 without forcing rework.

P3B1=organizations + organization_segments + organization_segment_links. DEPENDS_ON=none. PROD_RISK=LOW. ROLLBACK=DROP TABLE. BACKFILL=none. TEST_GATE=schema+RLS (anon denied, internal allowed, segments seed).
P3B2=organization_sites + organization_contacts. DEPENDS_ON=P3B1. PROD_RISK=LOW. ROLLBACK=DROP TABLE. BACKFILL=none. TEST_GATE=FK integrity + RLS.
P3B3=crm_opportunities + crm_pipeline_events + crm_transition_opportunity RPC. DEPENDS_ON=P3B1,P3B2. PROD_RISK=MEDIUM. ROLLBACK=DROP TABLE+FUNCTION. BACKFILL=none. TEST_GATE=transition valid/invalid, event immutability, RLS.
P3B4=crm_activities + crm_timeline view. DEPENDS_ON=P3B1,P3B2,P3B3. PROD_RISK=LOW-MEDIUM. ROLLBACK=DROP TABLE+VIEW. BACKFILL=none. TEST_GATE=activity anchor CHECK, timeline stable fields, RLS no leakage.
P3B5=nullable FKs on clients/devis/missions (organization_id, devis_id, contact_id, opportunity_id) + guard trigger extension. DEPENDS_ON=P3B1,P3B3. PROD_RISK=MEDIUM. ROLLBACK=DROP COLUMN. BACKFILL=none (all NULL). TEST_GATE=existing rows/flows regression-free, guard trigger blocks non-admin organization_id write.
P3B6=indexes + RLS consolidation + conversion/merge/bulk-import RPCs. DEPENDS_ON=P3B1–P3B5. PROD_RISK=MEDIUM. ROLLBACK=DROP INDEX/FUNCTION. BACKFILL=none. TEST_GATE=EXPLAIN uses indexes, conversion atomic, merge admin-only+audited, bulk import row limit.

BLOCKERS=none. Operator model (is_operator: user_roles + internal_operators.active) is safe and mature. clients.role protected by guard trigger. All P3B migrations additive and independently reversible.

MIGRATION=NO
CODE_CHANGE=NO
DB_WRITE=NO
PUSH=NO

P3A1_RESULT=PASS
```
