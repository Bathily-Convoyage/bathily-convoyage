-- =====================================================
-- Migration 008 : Fix RLS sur public.clients
-- Problème : Security Advisor signalait RLS désactivé
-- Solution : Suppression et recréation des politiques
-- =====================================================

-- Supprimer toutes les anciennes politiques
DROP POLICY IF EXISTS "Clients peuvent s'inscrire" ON public.clients;
DROP POLICY IF EXISTS "Clients peuvent voir leur profil" ON public.clients;
DROP POLICY IF EXISTS "Clients peuvent modifier leur profil" ON public.clients;
DROP POLICY IF EXISTS "Admin peut tout voir" ON public.clients;
DROP POLICY IF EXISTS "Lecture bloquée anon" ON public.clients;
DROP POLICY IF EXISTS "Modification bloquée anon" ON public.clients;
DROP POLICY IF EXISTS "Suppression bloquée" ON public.clients;

-- Activer RLS (idempotent)
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- Politique : Inscription publique autorisée
CREATE POLICY "Clients peuvent s'inscrire"
  ON public.clients FOR INSERT WITH CHECK (true);

-- Politique : Lecture bloquée pour anon (admin utilise service_role qui bypass RLS)
CREATE POLICY "Lecture bloquée anon"
  ON public.clients FOR SELECT USING (false);

-- Politique : Modification bloquée pour anon
CREATE POLICY "Modification bloquée anon"
  ON public.clients FOR UPDATE USING (false);

-- Politique : Suppression bloquée pour anon
CREATE POLICY "Suppression bloquée"
  ON public.clients FOR DELETE USING (false);
