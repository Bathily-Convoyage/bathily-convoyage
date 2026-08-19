-- Vehicle catalog foundation
-- Source: ADEME Car Labelling (open data)
-- Reference data layer for vehicle make/model/variant fallback

create table if not exists vehicle_catalog_sources (
  id text primary key,
  display_name text not null,
  source_url text,
  license text,
  source_version text,
  source_updated_at timestamptz null,
  content_sha256 text null,
  last_synced_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists vehicle_makes (
  id bigint generated always as identity primary key,
  name text not null,
  normalized_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_name)
);

create table if not exists vehicle_models (
  id bigint generated always as identity primary key,
  make_id bigint not null,
  name text not null,
  normalized_name text not null,
  year_from smallint null,
  year_to smallint null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (make_id) references vehicle_makes(id) on delete restrict,
  unique (make_id, normalized_name)
);

create table if not exists vehicle_variants (
  id bigint generated always as identity primary key,
  model_id bigint not null,
  source_id text not null,
  source_record_id text not null,
  commercial_name text null,
  energy text null,
  fiscal_power numeric null,
  max_power_value numeric null,
  max_power_unit text null,
  source_hash text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (model_id) references vehicle_models(id) on delete restrict,
  foreign key (source_id) references vehicle_catalog_sources(id) on delete restrict,
  unique (source_id, source_record_id)
);

-- Indexes
create index if not exists vehicle_models_make_id_idx on vehicle_models(make_id);
create index if not exists vehicle_models_year_from_idx on vehicle_models(year_from);
create index if not exists vehicle_models_year_to_idx on vehicle_models(year_to);
create index if not exists vehicle_variants_model_id_idx on vehicle_variants(model_id);
create index if not exists vehicle_variants_source_id_idx on vehicle_variants(source_id);

-- RLS
alter table vehicle_makes enable row level security;
alter table vehicle_models enable row level security;
alter table vehicle_variants enable row level security;
alter table vehicle_catalog_sources enable row level security;

-- Application roles: SELECT only
-- Use RLS policies (no GRANT modifications to reserved roles; rely on default Postgres permissions)
create policy "vehicle_makes_select_anon" on vehicle_makes for select to anon using (true);
create policy "vehicle_makes_select_authenticated" on vehicle_makes for select to authenticated using (true);

create policy "vehicle_models_select_anon" on vehicle_models for select to anon using (true);
create policy "vehicle_models_select_authenticated" on vehicle_models for select to authenticated using (true);

create policy "vehicle_variants_select_anon" on vehicle_variants for select to anon using (true);
create policy "vehicle_variants_select_authenticated" on vehicle_variants for select to authenticated using (true);

create policy "vehicle_catalog_sources_select_anon" on vehicle_catalog_sources for select to anon using (true);
create policy "vehicle_catalog_sources_select_authenticated" on vehicle_catalog_sources for select to authenticated using (true);

-- Seed source reference row
insert into vehicle_catalog_sources (id, display_name, source_url, license, source_version)
values (
  'ADEME_CAR_LABELLING',
  'ADEME - Car Labelling',
  'https://data.ademe.fr/data-fair/api/v1/datasets/ademe-car-labelling',
  'Open Data / Licence Ouverte',
  null
)
on conflict (id) do update set
  display_name = excluded.display_name,
  source_url = excluded.source_url,
  license = excluded.license,
  updated_at = now();
