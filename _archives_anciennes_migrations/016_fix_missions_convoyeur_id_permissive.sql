-- =====================================================
-- Migration 016 : Rattachement des missions historiques (VERSION PERMISSIVE)
-- Met à jour convoyeur_id pour les missions existantes
-- avec recherche souple pour gérer les formats de noms variés
-- =====================================================

-- Mettre à jour les missions qui ont un convoyeur_nom mais pas de convoyeur_id
-- Recherche plus permissive : case-insensitive et partielle
UPDATE public.missions m
SET convoyeur_id = c.id
FROM public.convoyeurs c
WHERE m.convoyeur_nom IS NOT NULL 
  AND m.convoyeur_id IS NULL
  AND (
    -- Match exact sur prénom + nom ou nom + prénom
    (c.prenom || ' ' || c.nom) = m.convoyeur_nom
    OR (c.nom || ' ' || c.prenom) = m.convoyeur_nom
    OR c.prenom = m.convoyeur_nom
    OR c.nom = m.convoyeur_nom
    -- Match case-insensitive
    OR LOWER(c.prenom || ' ' || c.nom) = LOWER(m.convoyeur_nom)
    OR LOWER(c.nom || ' ' || c.prenom) = LOWER(m.convoyeur_nom)
    -- Match partiel : le nom contient le nom du convoyeur
    OR LOWER(m.convoyeur_nom) LIKE '%' || LOWER(c.nom) || '%'
    OR LOWER(m.convoyeur_nom) LIKE '%' || LOWER(c.prenom) || '%'
    -- Match inverse : le nom du convoyeur contient le nom de la mission
    OR LOWER(c.nom) LIKE '%' || LOWER(m.convoyeur_nom) || '%'
    OR LOWER(c.prenom || ' ' || c.nom) LIKE '%' || LOWER(m.convoyeur_nom) || '%'
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
