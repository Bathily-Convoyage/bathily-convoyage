-- Create system_settings table to store dynamic configurations like packs
CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- Allow read access to everyone (so devis.html can read pack prices)
CREATE POLICY "Allow public read access on system_settings"
    ON public.system_settings FOR SELECT
    USING (true);

-- Allow all access to authenticated users (admin)
CREATE POLICY "Allow authenticated users to manage system_settings"
    ON public.system_settings FOR ALL
    USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

-- Insert default configurations
INSERT INTO public.system_settings (key, value) VALUES 
('pack_starter', '{"name": "Starter", "price": 0, "features": "Logistique de convoyage standard\nDouble assurance RC Pro\nIdentification SIV\nÉtat des lieux numérisé (20 photos)\nSuivi GPS basique"}'::jsonb),
('pack_serenite', '{"name": "Sérénité", "price": 49, "features": "Nettoyage extérieur haute pression\nMise à niveau carburant / charge\nCheck-list digitale par email"}'::jsonb),
('pack_excellence', '{"name": "Excellence", "price": 129, "features": "Préparation esthétique complète\nFull Energy — 100% charge / plein\nCadeau premium personnalisé"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
