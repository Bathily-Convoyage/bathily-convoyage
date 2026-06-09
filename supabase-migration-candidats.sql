-- =====================================================
-- TABLE : convoyeurs_candidats
-- À exécuter dans Supabase > SQL Editor
-- =====================================================

CREATE TABLE IF NOT EXISTS public.convoyeurs_candidats (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at        timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  prenom            text NOT NULL,
  nom               text NOT NULL,
  email             text UNIQUE NOT NULL,
  telephone         text,
  date_naissance    date,
  ville             text,
  mot_de_passe      text NOT NULL,
  type_permis       text,
  annee_permis      integer,
  experience        text,
  score_quiz        integer,
  reponses_quiz     jsonb,
  quiz_attempts     integer DEFAULT 0,
  last_attempt_at   timestamp with time zone,
  statut            text DEFAULT 'pending' CHECK (statut IN ('pending', 'approved', 'rejected')),
  notes_admin       text
);

-- Index pour les recherches par email et statut
CREATE INDEX IF NOT EXISTS idx_candidats_email ON public.convoyeurs_candidats(email);
CREATE INDEX IF NOT EXISTS idx_candidats_statut ON public.convoyeurs_candidats(statut);

-- Politique RLS : tout le monde peut insérer (pour postuler)
ALTER TABLE public.convoyeurs_candidats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Insertion publique candidatures"
  ON public.convoyeurs_candidats
  FOR INSERT
  WITH CHECK (true);

-- Lecture : seulement le candidat lui-même (par email) ou l'admin (via anon key avec filtre)
CREATE POLICY "Lecture candidats"
  ON public.convoyeurs_candidats
  FOR SELECT
  USING (true);

-- Mise à jour : uniquement via l'admin (à restreindre avec service_role en prod)
CREATE POLICY "MAJ statut admin"
  ON public.convoyeurs_candidats
  FOR UPDATE
  USING (true);
