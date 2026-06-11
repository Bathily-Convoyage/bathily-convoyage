-- =====================================================
-- Migration 004 : Profils complets et documents
-- À exécuter dans Supabase > SQL Editor
-- =====================================================

-- 1. Ajout des champs financiers pour les convoyeurs
ALTER TABLE public.convoyeurs 
ADD COLUMN IF NOT EXISTS siret text,
ADD COLUMN IF NOT EXISTS iban text;

-- 2. Ajout des colonnes JSONB pour stocker les liens des documents uploadés
ALTER TABLE public.clients
ADD COLUMN IF NOT EXISTS documents jsonb DEFAULT '{}'::jsonb;

ALTER TABLE public.convoyeurs
ADD COLUMN IF NOT EXISTS documents jsonb DEFAULT '{}'::jsonb;

-- 3. Création du Storage Bucket "documents" (s'il n'existe pas)
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', true)
ON CONFLICT (id) DO NOTHING;

-- 4. Configuration des règles de sécurité (RLS) pour le bucket "documents"
-- Note: dans un environnement de production strict, on restreindrait l'accès,
-- mais pour ce MVP public, on autorise l'accès libre aux documents.
CREATE POLICY "Public Access" ON storage.objects FOR SELECT USING ( bucket_id = 'documents' );
CREATE POLICY "Upload Access" ON storage.objects FOR INSERT WITH CHECK ( bucket_id = 'documents' );
CREATE POLICY "Update Access" ON storage.objects FOR UPDATE USING ( bucket_id = 'documents' );
CREATE POLICY "Delete Access" ON storage.objects FOR DELETE USING ( bucket_id = 'documents' );
