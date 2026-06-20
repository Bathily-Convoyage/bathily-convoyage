-- =====================================================
-- Migration 013 : Tables manquantes
-- vehicules et support_tickets référencées dans le code
-- mais absentes du schéma
-- =====================================================

-- -------------------------------------------------------
-- TABLE : vehicules
-- Garages de véhicules des clients
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vehicules (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  updated_at      timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  client_id       uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  marque          text NOT NULL,
  modele          text NOT NULL,
  immatriculation text,
  annee           integer,
  carburant       text,
  couleur         text,
  notes           text
);

CREATE INDEX IF NOT EXISTS idx_vehicules_client_id ON public.vehicules(client_id);

CREATE TRIGGER update_vehicules_updated_at
  BEFORE UPDATE ON public.vehicules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.vehicules ENABLE ROW LEVEL SECURITY;

-- Un client authentifié voit et gère uniquement ses véhicules
CREATE POLICY "Client voit ses vehicules"
  ON public.vehicules FOR SELECT
  USING (
    client_id IN (SELECT id FROM public.clients WHERE email = auth.email())
  );

CREATE POLICY "Client ajoute ses vehicules"
  ON public.vehicules FOR INSERT
  WITH CHECK (
    client_id IN (SELECT id FROM public.clients WHERE email = auth.email())
  );

CREATE POLICY "Client modifie ses vehicules"
  ON public.vehicules FOR UPDATE
  USING (
    client_id IN (SELECT id FROM public.clients WHERE email = auth.email())
  );

CREATE POLICY "Client supprime ses vehicules"
  ON public.vehicules FOR DELETE
  USING (
    client_id IN (SELECT id FROM public.clients WHERE email = auth.email())
  );

-- -------------------------------------------------------
-- TABLE : support_tickets
-- Demandes de support des clients
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  updated_at      timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  client_id       uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  client_email    text NOT NULL,
  mission_id      uuid REFERENCES public.missions(id) ON DELETE SET NULL,
  sujet           text NOT NULL,
  message         text NOT NULL,
  statut          text DEFAULT 'ouvert' CHECK (statut IN ('ouvert', 'en_cours', 'resolu', 'ferme')),
  priorite        text DEFAULT 'normale' CHECK (priorite IN ('basse', 'normale', 'haute', 'urgente')),
  reponse_admin   text,
  repondu_at      timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_tickets_client_id ON public.support_tickets(client_id);
CREATE INDEX IF NOT EXISTS idx_tickets_statut ON public.support_tickets(statut);

CREATE TRIGGER update_tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

-- Un client peut créer un ticket et voir ses propres tickets
CREATE POLICY "Client cree ticket"
  ON public.support_tickets FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Client voit ses tickets"
  ON public.support_tickets FOR SELECT
  USING (
    client_id IN (SELECT id FROM public.clients WHERE email = auth.email())
  );

-- Update bloqué anon (admin via service_role)
CREATE POLICY "MAJ tickets bloquee anon"
  ON public.support_tickets FOR UPDATE
  USING (false);

CREATE POLICY "Suppression tickets bloquee"
  ON public.support_tickets FOR DELETE
  USING (false);

-- Recharger le cache du schéma
NOTIFY pgrst, 'reload schema';
