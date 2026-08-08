-- =====================================================
-- Migration 062 : Ajout des médias convoyeur et photos fin de mission
--    - selfie et vidéo de présentation pour les candidatures et convoyeurs
--    - photo de fin de mission pour les missions et les EDLs
-- =====================================================

-- Candidatures convoyeur
ALTER TABLE public.convoyeur_candidatures
  ADD COLUMN IF NOT EXISTS selfie text,
  ADD COLUMN IF NOT EXISTS video_presentation text;

-- Convoyeurs actifs
ALTER TABLE public.convoyeurs
  ADD COLUMN IF NOT EXISTS selfie text,
  ADD COLUMN IF NOT EXISTS video_presentation text;

-- Missions
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS photo_fin_mission text,
  ADD COLUMN IF NOT EXISTS fin_mission_selfie_uploaded_at timestamptz;

-- États des lieux
ALTER TABLE public.edls
  ADD COLUMN IF NOT EXISTS photo_fin_mission text,
  ADD COLUMN IF NOT EXISTS fin_mission_selfie_uploaded_at timestamptz;

NOTIFY pgrst, 'reload schema';
