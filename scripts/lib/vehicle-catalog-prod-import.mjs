// Pure preparation library for ADEME vehicle catalog first Production import.
// NO network, NO child process, NO DB client, NO credentials.
// Reads only local files and generates deterministic SQL.

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

export const REQUIRED_SNAPSHOT_FIELDS = [
  '_id',
  'Marque',
  'Libellé_modèle',
  'Modèle',
  'Description_Commerciale',
  'Energie',
  'Puissance_fiscale',
  'Puissance_maximale'
];

export const SOURCE_ID = 'ADEME_CAR_LABELLING';
export const DATASET_URL = 'https://data.ademe.fr/data-fair/api/v1/datasets/ademe-car-labelling';
export const CHUNK_SIZE = 400;

/**
 * Normalize a vehicle text value.
 * Uses NFKC, trims, collapses whitespace, uppercases.
 * Does NOT strip accents.
 */
export function normalizeVehicleValue(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function sha256File(filePath) {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

export function fileExists(filePath) {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isPathInsideRepo(absPath) {
  const resolved = resolve(absPath);
  return resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + '\\') || resolved.startsWith(REPO_ROOT + '/');
}

export function loadAndValidatePlan(planPath) {
  if (!fileExists(planPath)) throw new Error(`Plan file not found: ${planPath}`);
  const raw = readFileSync(planPath, 'utf8');
  const plan = JSON.parse(raw);
  const required = [
    'plan_version',
    'mode',
    'source_id',
    'dataset_id',
    'dataset_updated_at',
    'license',
    'snapshot_sha256',
    'snapshot_rows',
    'expected_accepted',
    'expected_rejected',
    'expected_makes',
    'expected_models',
    'expected_variants',
    'max_power_unit'
  ];
  for (const key of required) {
    if (!(key in plan)) throw new Error(`Missing plan field: ${key}`);
  }
  if (plan.mode !== 'first-production-import') {
    throw new Error(`Unsupported plan mode: ${plan.mode}`);
  }
  if (plan.source_id !== SOURCE_ID) {
    throw new Error(`Unexpected source_id: ${plan.source_id}`);
  }
  return plan;
}

export function loadAndVerifyManifest(manifestPath, plan) {
  if (!fileExists(manifestPath)) throw new Error(`Manifest file not found: ${manifestPath}`);
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  if (manifest.datasetId !== plan.dataset_id) {
    throw new Error(`Manifest datasetId mismatch: ${manifest.datasetId} !== ${plan.dataset_id}`);
  }
  if (manifest.datasetUpdatedAt !== plan.dataset_updated_at) {
    throw new Error(`Manifest datasetUpdatedAt mismatch: ${manifest.datasetUpdatedAt} !== ${plan.dataset_updated_at}`);
  }
  if (manifest.rowCount !== plan.snapshot_rows) {
    throw new Error(`Manifest rowCount mismatch: ${manifest.rowCount} !== ${plan.snapshot_rows}`);
  }
  if (manifest.snapshotSha256 !== plan.snapshot_sha256) {
    throw new Error(`Manifest snapshotSha256 mismatch: ${manifest.snapshotSha256} !== ${plan.snapshot_sha256}`);
  }
  return manifest;
}

export function loadAndVerifySnapshot(snapshotPath, plan) {
  if (!fileExists(snapshotPath)) throw new Error(`Snapshot file not found: ${snapshotPath}`);
  const actualSha256 = sha256File(snapshotPath);
  if (actualSha256 !== plan.snapshot_sha256) {
    throw new Error(`Snapshot SHA256 mismatch: ${actualSha256} !== ${plan.snapshot_sha256}`);
  }
  const raw = readFileSync(snapshotPath, 'utf8');
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error('Snapshot must be a JSON array');
  if (rows.length !== plan.snapshot_rows) {
    throw new Error(`Snapshot row count mismatch: ${rows.length} !== ${plan.snapshot_rows}`);
  }
  // Source contract validation: required fields must exist as keys on the first row (schema-level check).
  // Individual rows may have null/absent optional values (e.g., electric vehicles without Puissance_maximale).
  if (rows.length > 0) {
    const sample = rows[0];
    for (const field of REQUIRED_SNAPSHOT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(sample, field)) {
        throw new Error(`Missing required field in snapshot schema: ${field}`);
      }
    }
  }
  return rows;
}

export function isNumeric(value) {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'number') return Number.isFinite(value);
  const s = String(value).replace(',', '.').trim();
  if (s === '') return false;
  const n = Number(s);
  return !Number.isNaN(n) && Number.isFinite(n);
}

export function toNum(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).replace(',', '.').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isNaN(n) || !Number.isFinite(n) ? null : n;
}

function escapeSqlString(value) {
  if (value === null || value === undefined) return 'null';
  const s = String(value);
  if (s.includes('\0')) throw new Error('NUL character not allowed in SQL string literal');
  return `'${s.replace(/'/g, "''")}'`;
}

function formatTimestamp(iso) {
  if (!iso) return 'null';
  return escapeSqlString(iso);
}

/**
 * Build the vehicle catalog in memory.
 * Returns { makes, models, variants, accepted, rejected, stats }.
 */
export function buildVehicleCatalog(rows, plan) {
  const makes = new Map(); // normalized_name -> { name, normalized_name }
  const models = new Map(); // make_norm:model_norm -> { make, model, make_normalized, model_normalized }
  const variants = [];
  let accepted = 0;
  let rejected = 0;
  const rejectionReasons = {};
  const sourceIdSet = new Set();
  const duplicateSourceIds = new Set();

  const fiscalStats = { null: 0, empty: 0, valid: 0, invalid: 0, negative: 0, zero: 0 };
  const maxPowerStats = { null: 0, empty: 0, valid: 0, invalid: 0, negative: 0, zero: 0 };
  const energyValues = new Map();
  let nullCommercialName = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sourceRecordId = row._id;

    if (sourceRecordId === null || sourceRecordId === undefined || String(sourceRecordId) === '') {
      rejected++;
      rejectionReasons.missing_source_id = (rejectionReasons.missing_source_id || 0) + 1;
      continue;
    }
    const sid = String(sourceRecordId);
    if (sourceIdSet.has(sid)) {
      duplicateSourceIds.add(sid);
      rejected++;
      rejectionReasons.duplicate_source_id = (rejectionReasons.duplicate_source_id || 0) + 1;
      continue;
    }
    sourceIdSet.add(sid);

    const make = row['Marque'];
    const modelDisplay = row['Libellé_modèle'];
    const modelTech = row['Modèle'];
    const modelName = modelDisplay || modelTech;
    const commercialName = row['Description_Commerciale'];
    const energy = row['Energie'];
    const fiscalPower = row['Puissance_fiscale'];
    const maxPower = row['Puissance_maximale'];

    if (!make || !modelName) {
      rejected++;
      if (!make && !modelName) rejectionReasons.missing_make_and_model = (rejectionReasons.missing_make_and_model || 0) + 1;
      else if (!make) rejectionReasons.missing_make = (rejectionReasons.missing_make || 0) + 1;
      else rejectionReasons.missing_model = (rejectionReasons.missing_model || 0) + 1;
      continue;
    }

    accepted++;

    const makeNorm = normalizeVehicleValue(make);
    const modelNorm = normalizeVehicleValue(modelName);

    if (!makes.has(makeNorm)) {
      makes.set(makeNorm, { name: String(make).trim(), normalized_name: makeNorm });
    }

    const modelKey = `${makeNorm}:${modelNorm}`;
    if (!models.has(modelKey)) {
      models.set(modelKey, {
        make: String(make).trim(),
        model: String(modelName).trim(),
        make_normalized: makeNorm,
        model_normalized: modelNorm,
        year_from: null,
        year_to: null
      });
    }

    // Commercial name
    if (commercialName === null || commercialName === undefined || String(commercialName).trim() === '') nullCommercialName++;

    // Energy
    if (energy === null || energy === undefined || String(energy).trim() === '') {
      // count separately if needed
    } else {
      const ev = String(energy).trim();
      energyValues.set(ev, (energyValues.get(ev) || 0) + 1);
    }

    // Fiscal power
    if (fiscalPower === null || fiscalPower === undefined || fiscalPower === '') fiscalStats.null++;
    else if (!isNumeric(fiscalPower)) { fiscalStats.invalid++; }
    else {
      const n = toNum(fiscalPower);
      if (n === null) fiscalStats.invalid++;
      else if (n < 0) fiscalStats.negative++;
      else if (n === 0) fiscalStats.zero++;
      else fiscalStats.valid++;
    }

    // Max power
    if (maxPower === null || maxPower === undefined || maxPower === '') maxPowerStats.null++;
    else if (!isNumeric(maxPower)) { maxPowerStats.invalid++; }
    else {
      const n = toNum(maxPower);
      if (n === null) maxPowerStats.invalid++;
      else if (n < 0) maxPowerStats.negative++;
      else if (n === 0) maxPowerStats.zero++;
      else maxPowerStats.valid++;
    }

    const rowHash = createHash('sha256')
      .update(JSON.stringify({
        make,
        model: modelName,
        variant: commercialName,
        energy,
        fiscalPower,
        maxPower,
        sourceRecordId
      }))
      .digest('hex');

    variants.push({
      make_normalized: makeNorm,
      model_normalized: modelNorm,
      source_record_id: sid,
      commercial_name: commercialName || null,
      energy: energy || null,
      fiscal_power: toNum(fiscalPower),
      max_power_value: toNum(maxPower),
      max_power_unit: toNum(maxPower) === null ? null : plan.max_power_unit,
      source_hash: rowHash
    });
  }

  // Detect normalization collisions
  const makeNormToRaws = new Map();
  const modelNormToRaws = new Map();
  for (const row of rows) {
    const make = row['Marque'];
    const modelDisplay = row['Libellé_modèle'];
    const modelTech = row['Modèle'];
    const modelName = modelDisplay || modelTech;
    if (!make || !modelName) continue;
    const makeNorm = normalizeVehicleValue(make);
    if (!makeNormToRaws.has(makeNorm)) makeNormToRaws.set(makeNorm, new Set());
    makeNormToRaws.get(makeNorm).add(String(make).trim());
    const modelKey = `${makeNorm}:${normalizeVehicleValue(modelName)}`;
    if (!modelNormToRaws.has(modelKey)) modelNormToRaws.set(modelKey, new Set());
    modelNormToRaws.get(modelKey).add(`${String(make).trim()}|${String(modelName).trim()}`);
  }

  const makeCollisions = [];
  for (const [norm, raws] of makeNormToRaws) {
    if (raws.size > 1) makeCollisions.push({ normalized: norm, rawValues: [...raws] });
  }
  const modelCollisions = [];
  for (const [norm, raws] of modelNormToRaws) {
    if (raws.size > 1) modelCollisions.push({ normalized: norm, rawValues: [...raws] });
  }

  return {
    makes: [...makes.values()].sort((a, b) => a.normalized_name.localeCompare(b.normalized_name)),
    models: [...models.values()].sort((a, b) => {
      const c = a.make_normalized.localeCompare(b.make_normalized);
      return c !== 0 ? c : a.model_normalized.localeCompare(b.model_normalized);
    }),
    variants: variants.sort((a, b) => a.source_record_id.localeCompare(b.source_record_id)),
    accepted,
    rejected,
    rejectionReasons,
    duplicateSourceIds: [...duplicateSourceIds],
    makeCollisions,
    modelCollisions,
    fiscalStats,
    maxPowerStats,
    energyValues,
    nullCommercialName
  };
}

/**
 * Validate the built catalog against the plan.
 */
export function validateCatalog(plan, catalog) {
  if (catalog.rejected !== plan.expected_rejected) {
    throw new Error(`Rejected count mismatch: ${catalog.rejected} !== ${plan.expected_rejected}`);
  }
  if (catalog.accepted !== plan.expected_accepted) {
    throw new Error(`Accepted count mismatch: ${catalog.accepted} !== ${plan.expected_accepted}`);
  }
  if (catalog.makes.length !== plan.expected_makes) {
    throw new Error(`Makes count mismatch: ${catalog.makes.length} !== ${plan.expected_makes}`);
  }
  if (catalog.models.length !== plan.expected_models) {
    throw new Error(`Models count mismatch: ${catalog.models.length} !== ${plan.expected_models}`);
  }
  if (catalog.variants.length !== plan.expected_variants) {
    throw new Error(`Variants count mismatch: ${catalog.variants.length} !== ${plan.expected_variants}`);
  }
  if (catalog.duplicateSourceIds.length > 0) {
    throw new Error(`Duplicate source IDs detected: ${catalog.duplicateSourceIds.join(', ')}`);
  }
  if (catalog.makeCollisions.length > 0) {
    throw new Error(`Make normalization collisions detected`);
  }
  if (catalog.modelCollisions.length > 0) {
    throw new Error(`Model normalization collisions detected`);
  }
}

/**
 * Generate the deterministic first-import SQL.
 */
export function generateFirstProdImportSql(plan, manifest, catalog) {
  const lines = [];

  lines.push('-- FIRST PRODUCTION IMPORT ONLY');
  lines.push('-- Generated by prepare-ademe-vehicle-catalog-prod-import.mjs');
  lines.push(`-- Source: ${DATASET_URL}`);
  lines.push(`-- Dataset updatedAt: ${plan.dataset_updated_at}`);
  lines.push(`-- Snapshot SHA256: ${plan.snapshot_sha256}`);
  lines.push(`-- Expected rows: ${plan.snapshot_rows}`);
  lines.push('--');
  lines.push('BEGIN;');
  lines.push('SET LOCAL standard_conforming_strings = on;');
  lines.push('');

  // Preconditions
  lines.push('-- PRECONDITIONS: first-import empty state');
  lines.push(`DO $$`);
  lines.push(`BEGIN`);
  lines.push(`  IF (SELECT count(*) FROM vehicle_catalog_sources) <> 1 THEN`);
  lines.push(`    RAISE EXCEPTION 'Precondition failed: vehicle_catalog_sources count must be 1';`);
  lines.push(`  END IF;`);
  lines.push(`  IF NOT EXISTS (SELECT 1 FROM vehicle_catalog_sources WHERE id = ${escapeSqlString(SOURCE_ID)}) THEN`);
  lines.push(`    RAISE EXCEPTION 'Precondition failed: ADEME_CAR_LABELLING source row missing';`);
  lines.push(`  END IF;`);
  lines.push(`  IF (SELECT count(*) FROM vehicle_makes) <> 0 THEN`);
  lines.push(`    RAISE EXCEPTION 'Precondition failed: vehicle_makes must be empty for first import';`);
  lines.push(`  END IF;`);
  lines.push(`  IF (SELECT count(*) FROM vehicle_models) <> 0 THEN`);
  lines.push(`    RAISE EXCEPTION 'Precondition failed: vehicle_models must be empty for first import';`);
  lines.push(`  END IF;`);
  lines.push(`  IF (SELECT count(*) FROM vehicle_variants) <> 0 THEN`);
  lines.push(`    RAISE EXCEPTION 'Precondition failed: vehicle_variants must be empty for first import';`);
  lines.push(`  END IF;`);
  lines.push(`END $$;`);
  lines.push('');

  // Source metadata upsert
  lines.push('-- Update source metadata');
  lines.push(`INSERT INTO vehicle_catalog_sources (id, display_name, source_url, license, source_version, source_updated_at, content_sha256, last_synced_at)`);
  lines.push(`VALUES (`);
  lines.push(`  ${escapeSqlString(SOURCE_ID)},`);
  lines.push(`  ${escapeSqlString('ADEME - Car Labelling')},`);
  lines.push(`  ${escapeSqlString(DATASET_URL)},`);
  lines.push(`  ${escapeSqlString(plan.license)},`);
  lines.push(`  null,`);
  lines.push(`  ${formatTimestamp(plan.dataset_updated_at)}::timestamptz,`);
  lines.push(`  ${escapeSqlString(plan.snapshot_sha256)},`);
  lines.push(`  now()`);
  lines.push(`)`);
  lines.push(`ON CONFLICT (id) DO UPDATE SET`);
  lines.push(`  display_name = EXCLUDED.display_name,`);
  lines.push(`  source_url = EXCLUDED.source_url,`);
  lines.push(`  license = EXCLUDED.license,`);
  lines.push(`  source_version = EXCLUDED.source_version,`);
  lines.push(`  source_updated_at = EXCLUDED.source_updated_at,`);
  lines.push(`  content_sha256 = EXCLUDED.content_sha256,`);
  lines.push(`  last_synced_at = EXCLUDED.last_synced_at`);
  lines.push(`  -- updated_at intentionally omitted; trigger absent and data layer unchanged`);
  lines.push(`  ;`);
  lines.push('');

  // Snapshot SHA assertion
  lines.push('-- Snapshot SHA assertion');
  lines.push(`DO $$`);
  lines.push(`BEGIN`);
  lines.push(`  IF NOT EXISTS (`);
  lines.push(`    SELECT 1 FROM vehicle_catalog_sources`);
  lines.push(`    WHERE id = ${escapeSqlString(SOURCE_ID)} AND content_sha256 = ${escapeSqlString(plan.snapshot_sha256)}`);
  lines.push(`  ) THEN`);
  lines.push(`    RAISE EXCEPTION 'Snapshot SHA assertion failed';`);
  lines.push(`  END IF;`);
  lines.push(`END $$;`);
  lines.push('');

  // Makes upsert
  lines.push('-- Upsert makes');
  if (catalog.makes.length > 0) {
    lines.push(`INSERT INTO vehicle_makes (name, normalized_name, created_at, updated_at) VALUES`);
    const makeValues = catalog.makes.map(m =>
      `(${escapeSqlString(m.name)}, ${escapeSqlString(m.normalized_name)}, now(), now())`
    );
    lines.push(makeValues.join(',\n'));
    lines.push(`ON CONFLICT (normalized_name) DO UPDATE SET`);
    lines.push(`  name = EXCLUDED.name,`);
    lines.push(`  updated_at = now()`);
    lines.push(`  WHERE vehicle_makes.name IS DISTINCT FROM EXCLUDED.name;`);
  }
  lines.push('');

  // Models upsert
  lines.push('-- Upsert models');
  if (catalog.models.length > 0) {
    lines.push(`WITH make_map AS (SELECT id, normalized_name FROM vehicle_makes)`);
    lines.push(`INSERT INTO vehicle_models (make_id, name, normalized_name, year_from, year_to, created_at, updated_at)`);
    const modelValues = catalog.models.map(m =>
      `((SELECT id FROM make_map WHERE normalized_name = ${escapeSqlString(m.make_normalized)}), ${escapeSqlString(m.model)}, ${escapeSqlString(m.model_normalized)}, null, null, now(), now())`
    );
    lines.push(`VALUES ${modelValues.join(',\n')}`);
    lines.push(`ON CONFLICT (make_id, normalized_name) DO UPDATE SET`);
    lines.push(`  name = EXCLUDED.name,`);
    lines.push(`  updated_at = now()`);
    lines.push(`  WHERE vehicle_models.name IS DISTINCT FROM EXCLUDED.name;`);
  }
  lines.push('');

  // Variants upsert in chunks
  lines.push('-- Upsert variants');
  if (catalog.variants.length > 0) {
    for (let i = 0; i < catalog.variants.length; i += CHUNK_SIZE) {
      const chunk = catalog.variants.slice(i, i + CHUNK_SIZE);
      lines.push(`WITH mm AS (`);
      lines.push(`  SELECT m.id AS model_id, m.make_id, mk.normalized_name AS make_normalized, m.normalized_name AS model_normalized`);
      lines.push(`  FROM vehicle_models m`);
      lines.push(`  JOIN vehicle_makes mk ON m.make_id = mk.id`);
      lines.push(`)`);
      lines.push(`INSERT INTO vehicle_variants (model_id, source_id, source_record_id, commercial_name, energy, fiscal_power, max_power_value, max_power_unit, source_hash, created_at, updated_at)`);
      const vValues = chunk.map(v => {
        const modelLookup = `(SELECT mm.model_id FROM mm WHERE mm.make_normalized = ${escapeSqlString(v.make_normalized)} AND mm.model_normalized = ${escapeSqlString(v.model_normalized)})`;
        return `${modelLookup}, ${escapeSqlString(SOURCE_ID)}, ${escapeSqlString(v.source_record_id)}, ${escapeSqlString(v.commercial_name)}, ${escapeSqlString(v.energy)}, ${v.fiscal_power === null ? 'null' : v.fiscal_power}, ${v.max_power_value === null ? 'null' : v.max_power_value}, ${escapeSqlString(v.max_power_unit)}, ${escapeSqlString(v.source_hash)}, now(), now()`;
      });
      lines.push(`VALUES ${vValues.join(',\n')}`);
      lines.push(`ON CONFLICT (source_id, source_record_id) DO UPDATE SET`);
      lines.push(`  model_id = EXCLUDED.model_id,`);
      lines.push(`  commercial_name = EXCLUDED.commercial_name,`);
      lines.push(`  energy = EXCLUDED.energy,`);
      lines.push(`  fiscal_power = EXCLUDED.fiscal_power,`);
      lines.push(`  max_power_value = EXCLUDED.max_power_value,`);
      lines.push(`  max_power_unit = EXCLUDED.max_power_unit,`);
      lines.push(`  source_hash = EXCLUDED.source_hash,`);
      lines.push(`  updated_at = now()`);
      lines.push(`  WHERE vehicle_variants.commercial_name IS DISTINCT FROM EXCLUDED.commercial_name`);
      lines.push(`     OR vehicle_variants.energy IS DISTINCT FROM EXCLUDED.energy`);
      lines.push(`     OR vehicle_variants.fiscal_power IS DISTINCT FROM EXCLUDED.fiscal_power`);
      lines.push(`     OR vehicle_variants.max_power_value IS DISTINCT FROM EXCLUDED.max_power_value`);
      lines.push(`     OR vehicle_variants.max_power_unit IS DISTINCT FROM EXCLUDED.max_power_unit`);
      lines.push(`     OR vehicle_variants.source_hash IS DISTINCT FROM EXCLUDED.source_hash;`);
    }
  }
  lines.push('');

  // Postconditions
  lines.push('-- POSTCONDITIONS');
  lines.push(`DO $$`);
  lines.push(`BEGIN`);
  lines.push(`  IF (SELECT count(*) FROM vehicle_catalog_sources) <> 1 THEN`);
  lines.push(`    RAISE EXCEPTION 'Postcondition failed: vehicle_catalog_sources count must be 1';`);
  lines.push(`  END IF;`);
  lines.push(`  IF NOT EXISTS (SELECT 1 FROM vehicle_catalog_sources WHERE id = ${escapeSqlString(SOURCE_ID)} AND content_sha256 = ${escapeSqlString(plan.snapshot_sha256)}) THEN`);
  lines.push(`    RAISE EXCEPTION 'Postcondition failed: source metadata SHA mismatch';`);
  lines.push(`  END IF;`);
  lines.push(`  IF (SELECT count(*) FROM vehicle_makes) <> ${plan.expected_makes} THEN`);
  lines.push(`    RAISE EXCEPTION 'Postcondition failed: vehicle_makes count expected ${plan.expected_makes}';`);
  lines.push(`  END IF;`);
  lines.push(`  IF (SELECT count(*) FROM vehicle_models) <> ${plan.expected_models} THEN`);
  lines.push(`    RAISE EXCEPTION 'Postcondition failed: vehicle_models count expected ${plan.expected_models}';`);
  lines.push(`  END IF;`);
  lines.push(`  IF (SELECT count(*) FROM vehicle_variants) <> ${plan.expected_variants} THEN`);
  lines.push(`    RAISE EXCEPTION 'Postcondition failed: vehicle_variants count expected ${plan.expected_variants}';`);
  lines.push(`  END IF;`);
  lines.push(`  IF EXISTS (`);
  lines.push(`    SELECT 1 FROM vehicle_models m`);
  lines.push(`    WHERE NOT EXISTS (SELECT 1 FROM vehicle_makes mk WHERE mk.id = m.make_id)`);
  lines.push(`  ) THEN`);
  lines.push(`    RAISE EXCEPTION 'Postcondition failed: orphan model detected';`);
  lines.push(`  END IF;`);
  lines.push(`  IF EXISTS (`);
  lines.push(`    SELECT 1 FROM vehicle_variants v`);
  lines.push(`    WHERE NOT EXISTS (SELECT 1 FROM vehicle_models m WHERE m.id = v.model_id)`);
  lines.push(`  ) THEN`);
  lines.push(`    RAISE EXCEPTION 'Postcondition failed: orphan variant detected';`);
  lines.push(`  END IF;`);
  lines.push(`  IF EXISTS (`);
  lines.push(`    SELECT 1 FROM vehicle_variants v`);
  lines.push(`    WHERE NOT EXISTS (SELECT 1 FROM vehicle_catalog_sources s WHERE s.id = v.source_id)`);
  lines.push(`  ) THEN`);
  lines.push(`    RAISE EXCEPTION 'Postcondition failed: variant without source';`);
  lines.push(`  END IF;`);
  lines.push(`END $$;`);
  lines.push('');

  lines.push('COMMIT;');

  return lines.join('\n');
}

export { REPO_ROOT };
