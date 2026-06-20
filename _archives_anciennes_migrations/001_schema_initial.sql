-- =====================================================
-- SCHÉMA INITIAL BATHILY-CONVOYAGE
-- Migration 001 : Tables principales
-- À exécuter dans Supabase > SQL Editor
-- =====================================================

-- =====================================================
-- TABLE : clients
-- Gestion des clients (particuliers et entreprises)
-- =====================================================

CREATE TABLE IF NOT EXISTS public.clients (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at        timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at        timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  
  -- Informations personnelles
  email             text UNIQUE NOT NULL,
  nom               text NOT NULL,
  prenom            text NOT NULL,
  telephone         text NOT NULL,
  
  -- Informations entreprise (optionnel pour particuliers)
  entreprise        text,
  siret             text,
  
  -- Adresse
  adresse           text,
  code_postal       text,
  ville             text,
  pays              text DEFAULT 'France',
  
  -- Statut et notes
  statut            text DEFAULT 'actif' CHECK (statut IN ('actif', 'inactif', 'suspendu')),
  notes             text,
  
  -- Authentification (hash du mot de passe)
  mot_de_passe      text NOT NULL
);

-- Index pour optimiser les recherches
CREATE INDEX IF NOT EXISTS idx_clients_email ON public.clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_statut ON public.clients(statut);
CREATE INDEX IF NOT EXISTS idx_clients_entreprise ON public.clients(entreprise) WHERE entreprise IS NOT NULL;

-- =====================================================
-- TABLE : convoyeurs
-- Convoyeurs actifs (validés après candidature)
-- =====================================================

CREATE TABLE IF NOT EXISTS public.convoyeurs (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at        timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at        timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  
  -- Lien avec la candidature d'origine
  candidat_id       uuid REFERENCES public.convoyeurs_candidats(id) ON DELETE SET NULL,
  
  -- Informations personnelles
  email             text UNIQUE NOT NULL,
  nom               text NOT NULL,
  prenom            text NOT NULL,
  telephone         text NOT NULL,
  date_naissance    date,
  
  -- Adresse
  adresse           text,
  code_postal       text,
  ville             text,
  
  -- Informations professionnelles
  type_permis       text NOT NULL,
  numero_permis     text,
  annee_permis      integer,
  experience        text,
  
  -- Statut et disponibilité
  statut            text DEFAULT 'disponible' CHECK (statut IN ('disponible', 'en_mission', 'indisponible', 'inactif')),
  disponibilite     jsonb DEFAULT '[]'::jsonb, -- Plages de disponibilité
  
  -- Évaluation et notes
  note_moyenne      numeric(3,2) DEFAULT 0.00,
  nombre_missions   integer DEFAULT 0,
  notes_admin       text,
  
  -- Authentification
  mot_de_passe      text NOT NULL
);

-- Index pour optimiser les recherches
CREATE INDEX IF NOT EXISTS idx_convoyeurs_email ON public.convoyeurs(email);
CREATE INDEX IF NOT EXISTS idx_convoyeurs_statut ON public.convoyeurs(statut);
CREATE INDEX IF NOT EXISTS idx_convoyeurs_ville ON public.convoyeurs(ville);

-- =====================================================
-- TABLE : missions
-- Gestion des missions de convoyage
-- =====================================================

CREATE TABLE IF NOT EXISTS public.missions (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at        timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at        timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  
  -- Référence unique
  reference         text UNIQUE NOT NULL, -- ex: BC-2026-001
  
  -- Relations
  client_id         uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  convoyeur_id      uuid REFERENCES public.convoyeurs(id) ON DELETE SET NULL,
  
  -- Informations véhicule
  vehicule_marque   text NOT NULL,
  vehicule_modele   text NOT NULL,
  vehicule_immat    text NOT NULL,
  vehicule_annee    integer,
  vehicule_type     text, -- berline, SUV, utilitaire, etc.
  
  -- Départ
  depart_adresse    text NOT NULL,
  depart_code_postal text,
  depart_ville      text NOT NULL,
  depart_date       timestamp with time zone NOT NULL,
  depart_contact    text, -- Nom du contact sur place
  depart_telephone  text,
  
  -- Arrivée
  arrivee_adresse   text NOT NULL,
  arrivee_code_postal text,
  arrivee_ville     text NOT NULL,
  arrivee_date      timestamp with time zone,
  arrivee_contact   text,
  arrivee_telephone text,
  
  -- Distance et durée estimées
  distance_km       integer,
  duree_estimee     interval,
  
  -- Statut de la mission
  statut            text DEFAULT 'planifiee' CHECK (statut IN (
    'planifiee',      -- Mission créée, en attente
    'confirmee',      -- Confirmée par le client
    'en_cours',       -- Convoyeur en route
    'terminee',       -- Mission terminée
    'annulee',        -- Annulée
    'litige'          -- Problème signalé
  )),
  
  -- Informations financières
  prix_ht           numeric(10,2),
  prix_ttc          numeric(10,2),
  tva               numeric(10,2),
  acompte_verse     numeric(10,2) DEFAULT 0.00,
  paiement_statut   text DEFAULT 'en_attente' CHECK (paiement_statut IN (
    'en_attente',
    'acompte_recu',
    'paye',
    'rembourse'
  )),
  
  -- Documents et suivi
  bon_mission_url   text, -- URL du bon de mission PDF
  facture_url       text, -- URL de la facture PDF
  
  -- Notes et observations
  instructions      text, -- Instructions spécifiques pour le convoyeur
  notes_admin       text,
  notes_client      text,
  
  -- Évaluation post-mission
  evaluation_client jsonb, -- {note: 5, commentaire: "..."}
  evaluation_convoyeur jsonb
);

-- Index pour optimiser les recherches
CREATE INDEX IF NOT EXISTS idx_missions_reference ON public.missions(reference);
CREATE INDEX IF NOT EXISTS idx_missions_client_id ON public.missions(client_id);
CREATE INDEX IF NOT EXISTS idx_missions_convoyeur_id ON public.missions(convoyeur_id);
CREATE INDEX IF NOT EXISTS idx_missions_statut ON public.missions(statut);
CREATE INDEX IF NOT EXISTS idx_missions_depart_date ON public.missions(depart_date);
CREATE INDEX IF NOT EXISTS idx_missions_depart_ville ON public.missions(depart_ville);
CREATE INDEX IF NOT EXISTS idx_missions_arrivee_ville ON public.missions(arrivee_ville);

-- =====================================================
-- POLITIQUES RLS (Row Level Security)
-- =====================================================

-- Activer RLS sur toutes les tables
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.convoyeurs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.missions ENABLE ROW LEVEL SECURITY;

-- CLIENTS : Politiques de sécurité
CREATE POLICY "Clients peuvent s'inscrire"
  ON public.clients
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Clients peuvent voir leur profil"
  ON public.clients
  FOR SELECT
  USING (true); -- À restreindre en production avec auth.uid()

CREATE POLICY "Clients peuvent modifier leur profil"
  ON public.clients
  FOR UPDATE
  USING (true); -- À restreindre en production

-- CONVOYEURS : Politiques de sécurité
CREATE POLICY "Lecture publique convoyeurs"
  ON public.convoyeurs
  FOR SELECT
  USING (true);

CREATE POLICY "Insertion admin convoyeurs"
  ON public.convoyeurs
  FOR INSERT
  WITH CHECK (true); -- À restreindre avec service_role

CREATE POLICY "MAJ convoyeurs"
  ON public.convoyeurs
  FOR UPDATE
  USING (true);

-- MISSIONS : Politiques de sécurité
CREATE POLICY "Lecture publique missions"
  ON public.missions
  FOR SELECT
  USING (true);

CREATE POLICY "Insertion missions"
  ON public.missions
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "MAJ missions"
  ON public.missions
  FOR UPDATE
  USING (true);

-- =====================================================
-- FONCTIONS UTILITAIRES
-- =====================================================

-- Fonction pour mettre à jour automatiquement updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers pour updated_at
CREATE TRIGGER update_clients_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_convoyeurs_updated_at
  BEFORE UPDATE ON public.convoyeurs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_missions_updated_at
  BEFORE UPDATE ON public.missions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Fonction pour générer une référence de mission unique
CREATE OR REPLACE FUNCTION public.generate_mission_reference()
RETURNS text AS $$
DECLARE
  new_ref text;
  counter integer;
BEGIN
  -- Format: BC-YYYY-NNN (ex: BC-2026-001)
  SELECT COUNT(*) + 1 INTO counter
  FROM public.missions
  WHERE EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_TIMESTAMP);
  
  new_ref := 'BC-' || EXTRACT(YEAR FROM CURRENT_TIMESTAMP) || '-' || LPAD(counter::text, 3, '0');
  
  RETURN new_ref;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- VUES UTILES
-- =====================================================

-- Vue : Missions avec informations client et convoyeur
CREATE OR REPLACE VIEW public.missions_details AS
SELECT 
  m.*,
  c.nom AS client_nom,
  c.prenom AS client_prenom,
  c.email AS client_email,
  c.telephone AS client_telephone,
  c.entreprise AS client_entreprise,
  cv.nom AS convoyeur_nom,
  cv.prenom AS convoyeur_prenom,
  cv.email AS convoyeur_email,
  cv.telephone AS convoyeur_telephone
FROM public.missions m
LEFT JOIN public.clients c ON m.client_id = c.id
LEFT JOIN public.convoyeurs cv ON m.convoyeur_id = cv.id;

-- Vue : Statistiques convoyeurs
CREATE OR REPLACE VIEW public.convoyeurs_stats AS
SELECT 
  cv.id,
  cv.nom,
  cv.prenom,
  cv.email,
  cv.statut,
  cv.note_moyenne,
  COUNT(m.id) AS total_missions,
  COUNT(CASE WHEN m.statut = 'terminee' THEN 1 END) AS missions_terminees,
  COUNT(CASE WHEN m.statut = 'en_cours' THEN 1 END) AS missions_en_cours
FROM public.convoyeurs cv
LEFT JOIN public.missions m ON cv.id = m.convoyeur_id
GROUP BY cv.id, cv.nom, cv.prenom, cv.email, cv.statut, cv.note_moyenne;

-- =====================================================
-- DONNÉES DE TEST (Optionnel - à supprimer en production)
-- =====================================================

-- Exemple de client
INSERT INTO public.clients (email, nom, prenom, telephone, entreprise, siret, adresse, code_postal, ville, mot_de_passe)
VALUES (
  'contact@exemple-entreprise.fr',
  'Dupont',
  'Jean',
  '0601020304',
  'Exemple Entreprise SAS',
  '12345678900012',
  '123 Rue de la République',
  '75001',
  'Paris',
  'hash_mot_de_passe_ici' -- À remplacer par un vrai hash
) ON CONFLICT (email) DO NOTHING;

-- Exemple de convoyeur
INSERT INTO public.convoyeurs (email, nom, prenom, telephone, type_permis, annee_permis, ville, mot_de_passe)
VALUES (
  'convoyeur@exemple.fr',
  'Martin',
  'Sophie',
  '0607080910',
  'B',
  2015,
  'Lyon',
  'hash_mot_de_passe_ici' -- À remplacer par un vrai hash
) ON CONFLICT (email) DO NOTHING;

-- =====================================================
-- FIN DU SCHÉMA INITIAL
-- =====================================================
