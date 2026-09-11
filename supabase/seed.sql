-- =========================================================
-- P3C2 LOCAL RUNTIME TEST SEED
-- =========================================================
-- Synthetic test data for local runtime database proof.
-- All UUIDs, emails, and names are deterministic and synthetic.
-- No production data, no real emails, no real users.
-- =========================================================

-- =========================================================
-- 1. AUTH USERS (synthetic)
-- =========================================================
-- Insert minimal auth.users rows for identity simulation.
-- encrypted_password is a bcrypt hash of "testtest" (synthetic).

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, raw_app_meta_data, raw_user_meta_data)
VALUES
  ('a1111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'admin-p3c2@example.invalid',
   '$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV1234567890abcdefghijklmnopqrstuv', now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('a2222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'operator-p3c2@example.invalid',
   '$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV1234567890abcdefghijklmnopqrstuv', now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('a3333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'operator-inactive-p3c2@example.invalid',
   '$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV1234567890abcdefghijklmnopqrstuv', now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('a4444444-4444-4444-4444-444444444444', 'authenticated', 'authenticated', 'client-p3c2@example.invalid',
   '$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV1234567890abcdefghijklmnopqrstuv', now(), now(), '{}'::jsonb, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- =========================================================
-- 2. INTERNAL OPERATORS (insert BEFORE user_roles to avoid
--    enforce_auth_role_separation trigger conflict)
-- =========================================================
-- Admin is NOT in internal_operators — is_admin() checks
-- user_roles.role='admin' directly. Operators MUST be in both
-- internal_operators AND user_roles with role='operator'.
INSERT INTO public.internal_operators (user_id, display_name, active) VALUES
  ('a2222222-2222-2222-2222-222222222222', 'Test Operator P3C2', true),
  ('a3333333-3333-3333-3333-333333333333', 'Test Inactive Operator P3C2', false)
ON CONFLICT (user_id) DO NOTHING;

-- =========================================================
-- 3. USER ROLES
-- =========================================================
-- Admin gets role='admin' only (not in internal_operators).
-- Operators get role='operator' (already in internal_operators).
INSERT INTO public.user_roles (user_id, role) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'admin'),
  ('a2222222-2222-2222-2222-222222222222', 'operator'),
  ('a3333333-3333-3333-3333-333333333333', 'operator')
ON CONFLICT (user_id, role) DO NOTHING;

-- =========================================================
-- 4. CLIENTS (for external client identity)
-- =========================================================
INSERT INTO public.clients (id, email, nom, prenom, role, auth_user_id, created_at)
VALUES
  ('c4444444-4444-4444-4444-444444444444', 'client-p3c2@example.invalid', 'TestClient', 'P3C2', 'client',
   'a4444444-4444-4444-4444-444444444444', now())
ON CONFLICT (id) DO NOTHING;

-- =========================================================
-- 5. ORGANIZATIONS
-- =========================================================
INSERT INTO public.organizations (id, legal_name, trade_name, status, created_at, updated_at)
VALUES
  ('01111111-1111-1111-1111-111111111111', 'Test Org A P3C2', 'Org A', 'active', now(), now()),
  ('02222222-2222-2222-2222-222222222222', 'Test Org B P3C2', 'Org B', 'active', now(), now())
ON CONFLICT (id) DO NOTHING;

-- =========================================================
-- 6. ORGANIZATION CONTACTS
-- =========================================================
INSERT INTO public.organization_contacts (id, organization_id, first_name, last_name, email, primary_contact, active, created_at, updated_at)
VALUES
  ('c1111111-1111-1111-1111-111111111111', '01111111-1111-1111-1111-111111111111', 'Contact', 'A1', 'contact-a1-p3c2@example.invalid', false, true, now(), now()),
  ('c1222222-2222-2222-2222-222222222222', '01111111-1111-1111-1111-111111111111', 'Contact', 'A2', 'contact-a2-p3c2@example.invalid', false, true, now(), now()),
  ('c2111111-1111-1111-1111-111111111111', '02222222-2222-2222-2222-222222222222', 'Contact', 'B1', 'contact-b1-p3c2@example.invalid', false, true, now(), now())
ON CONFLICT (id) DO NOTHING;

-- =========================================================
-- 7. CRM OPPORTUNITY
-- =========================================================
INSERT INTO public.crm_opportunities (id, organization_id, contact_id, title, stage, estimated_value, probability, created_at, updated_at)
VALUES
  ('d1111111-1111-1111-1111-111111111111', '01111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111',
   'Test Opportunity A P3C2', 'lead', 10000.00, 20, now(), now())
ON CONFLICT (id) DO NOTHING;
