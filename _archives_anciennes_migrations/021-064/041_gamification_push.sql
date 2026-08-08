-- =====================================================
-- Migration 041 : Gamification convoyeurs + Push subscriptions
-- =====================================================

-- Table badges
CREATE TABLE IF NOT EXISTS public.badges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,
  nom         TEXT NOT NULL,
  description TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT 'fa-medal',
  couleur     TEXT NOT NULL DEFAULT '#0A4D68',
  condition   TEXT NOT NULL,
  points      INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table convoyeur_badges (attribution)
CREATE TABLE IF NOT EXISTS public.convoyeur_badges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  badge_id      UUID NOT NULL REFERENCES public.badges(id) ON DELETE CASCADE,
  mission_id    UUID REFERENCES public.missions(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_badges_user ON public.convoyeur_badges (user_id);

ALTER TABLE public.convoyeur_badges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conv_badges_select_own" ON public.convoyeur_badges;
CREATE POLICY "conv_badges_select_own"
  ON public.convoyeur_badges FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Table push_subscriptions (notifications web push)
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT,
  auth_key    TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_user ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "push_select_own" ON public.push_subscriptions;
CREATE POLICY "push_select_own"
  ON public.push_subscriptions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "push_insert_own" ON public.push_subscriptions;
CREATE POLICY "push_insert_own"
  ON public.push_subscriptions FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "push_delete_own" ON public.push_subscriptions;
CREATE POLICY "push_delete_own"
  ON public.push_subscriptions FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Badges par defaut
INSERT INTO public.badges (code, nom, description, icon, couleur, condition, points) VALUES
  ('premiere_mission', 'Première mission', 'Completer votre premiere mission', 'fa-rocket', '#0A4D68', 'missions_count >= 1', 50),
  ('cinq_missions', 'Convoyeur actif', 'Completer 5 missions', 'fa-fire', '#F5A623', 'missions_count >= 5', 100),
  ('dix_missions', 'Convoyeur experimente', 'Completer 10 missions', 'fa-star', '#c9a56b', 'missions_count >= 10', 200),
  ('vingt_missions', 'Convoyeur expert', 'Completer 20 missions', 'fa-trophy', '#c9a56b', 'missions_count >= 20', 500),
  ('cinq_etoiles', 'Service 5 etoiles', 'Obtenir une note de 5/5', 'fa-star', '#F5A623', 'avg_rating >= 4.8', 100),
  ('ponctualite', 'Toujours a l''heure', 'Livrer 10 missions a l''heure', 'fa-clock', '#4A7C6B', 'on_time_count >= 10', 150),
  ('longue_distance', 'Marathonien', 'Completer une mission de +800km', 'fa-road', '#0A4D68', 'max_distance >= 800', 100),
  ('streak_3', 'Sur une lancee', '3 missions dans le meme mois', 'fa-bolt', '#F5A623', 'monthly_streak >= 3', 75),
  ('zero_incident', 'Sans faute', '10 missions sans incident', 'fa-shield-alt', '#4A7C6B', 'clean_count >= 10', 200),
  ('nuit_owl', 'Convoyeur de nuit', 'Completer une mission de nuit', 'fa-moon', '#6B625A', 'night_mission >= 1', 50)
ON CONFLICT (code) DO NOTHING;

NOTIFY pgrst, 'reload schema';
