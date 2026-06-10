-- =====================================================
-- TABLE : edls (États des Lieux)
-- À exécuter dans Supabase > SQL Editor
-- =====================================================

CREATE TABLE IF NOT EXISTS public.edls (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at        timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  mission_id        uuid REFERENCES public.missions(id) ON DELETE CASCADE,
  reference         text UNIQUE NOT NULL, -- ex: EDL-BC-2026-3866-DEP
  type              text NOT NULL CHECK (type IN ('depart', 'arrivee')),
  convoyeur_nom     text NOT NULL,
  permis            text,
  date_heure        timestamp with time zone NOT NULL,
  kilometrage       integer,
  niveau_carburant  integer,
  photos            jsonb DEFAULT '[]'::jsonb, -- Photos base64 ou URLs
  dommages          jsonb DEFAULT '[]'::jsonb, -- Dommages [{zone, type, desc}]
  documents         jsonb DEFAULT '[]'::jsonb, -- Documents validés
  conforme          boolean DEFAULT true,
  signatures        jsonb, -- {convoyeur: 'base64...', client: 'base64...'}
  observations      text,
  email_client      text
);

-- Index pour accélérer les recherches par mission et par type
CREATE INDEX IF NOT EXISTS idx_edls_mission_id ON public.edls(mission_id);

-- Activer la sécurité RLS
ALTER TABLE public.edls ENABLE ROW LEVEL SECURITY;

-- Politiques de sécurité (Lecture/écriture publique pour simplifier le prototype)
CREATE POLICY "Insertion publique edls" ON public.edls FOR INSERT WITH CHECK (true);
CREATE POLICY "Lecture publique edls" ON public.edls FOR SELECT USING (true);
CREATE POLICY "Mise a jour edls" ON public.edls FOR UPDATE USING (true);
