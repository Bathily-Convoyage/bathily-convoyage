-- =====================================================
-- Migration 015 : Rattachement des missions historiques
-- Met à jour convoyeur_id pour les missions existantes
-- qui n'ont que convoyeur_nom
-- =====================================================

-- Mettre à jour les missions qui ont un convoyeur_nom mais pas de convoyeur_id
UPDATE public.missions m
SET convoyeur_id = c.id
FROM public.convoyeurs c
WHERE m.convoyeur_nom IS NOT NULL 
  AND m.convoyeur_id IS NULL
  AND (
    -- Match sur prénom + nom ou nom + prénom
    (c.prenom || ' ' || c.nom) = m.convoyeur_nom
    OR (c.nom || ' ' || c.prenom) = m.convoyeur_nom
    OR c.prenom = m.convoyeur_nom
    OR c.nom = m.convoyeur_nom
  );

-- Vérifier les missions mises à jour
SELECT 
  'Missions mises à jour' AS status,
  COUNT(*) AS count
FROM public.missions
WHERE convoyeur_id IS NOT NULL AND convoyeur_nom IS NOT NULL

UNION ALL

-- Vérifier s'il reste des missions orphelines
SELECT 
  'Missions orphelines (sans ID)' AS status,
  COUNT(*) AS count
FROM public.missions
WHERE convoyeur_nom IS NOT NULL AND convoyeur_id IS NULL;
