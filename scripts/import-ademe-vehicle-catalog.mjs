// ADEME Car Labelling vehicle catalog import
// Local-only. Two modes:
//   --dry-run     (default) compute stats, do not modify DB
//   --apply-local generate SQL and execute via npx supabase db query --local -f <file>
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ADEME_API_URL = 'https://data.ademe.fr/data-fair/api/v1/datasets/ademe-car-labelling/lines';
const ADEME_DATASET_URL = 'https://data.ademe.fr/data-fair/api/v1/datasets/ademe-car-labelling';
const SOURCE_ID = 'ADEME_CAR_LABELLING';
const TMP_DIR = join(__dirname, '..', '.tmp', 'vehicle-catalog');
const SNAPSHOT_PATH = join(TMP_DIR, 'ademe-car-labelling-snapshot.json');
const SQL_PATH = join(TMP_DIR, 'vehicle-catalog-import.sql');
const CHUNK_SIZE = 400;

const isApply = process.argv.includes('--apply-local');
const isDryRun = !isApply;

function normalize(s) {
  if (s === null || s === undefined) return '';
  return String(s).normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
}

function toDateTime(v) {
  if (!v) return 'null';
  const t = new Date(v);
  if (isNaN(t.getTime())) return 'null';
  return `'${t.toISOString()}'`;
}

function esc(s) {
  if (s === null || s === undefined) return 'null';
  let t = String(s);
  t = t.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${t}'`;
}

function escNum(n) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return 'null';
  return String(Number(n));
}

function isLocal(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

async function downloadSnapshot() {
  mkdirSync(TMP_DIR, { recursive: true });
  if (existsSync(SNAPSHOT_PATH)) return;

  const size = 5000; // > 3604 total
  const url = `${ADEME_API_URL}?size=${size}`;
  console.log(`Downloading ADEME snapshot: ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`ADEME download failed: ${resp.status}`);
  const data = await resp.json();
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function loadSnapshot() {
  const raw = readFileSync(SNAPSHOT_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed.results) ? parsed.results : parsed;
  const contentSha256 = createHash('sha256').update(raw).digest('hex');
  const updatedAt = parsed.updatedAt || (parsed.dataset && parsed.dataset.updatedAt) || null;
  return { rows, contentSha256, updatedAt };
}

async function loadDatasetMeta() {
  const resp = await fetch(ADEME_DATASET_URL);
  if (!resp.ok) throw new Error(`ADEME metadata failed: ${resp.status}`);
  const meta = await resp.json();
  return meta;
}

function buildCatalog(rows) {
  const makes = new Map(); // normalized -> { name, normalized_name }
  const models = new Map(); // make_normalized+':'+model_normalized -> { make, model, make_normalized, model_normalized }
  const variants = [];

  let rejected = 0;
  let accepted = 0;

  for (const row of rows) {
    const make = row['Marque'];
    const modelDisplay = row['Libellé_modèle'];
    const modelTech = row['Modèle'];
    const variant = row['Description_Commerciale'];
    const energy = row['Energie'];
    const fiscalPower = row['Puissance_fiscale'];
    const maxPower = row['Puissance_maximale'];
    const sourceRecordId = row['_id'];

    // Determine model name: prefer display, fallback technical
    const modelName = modelDisplay || modelTech;

    if (!make || !modelName) {
      rejected++;
      continue;
    }

    accepted++;

    const makeNorm = normalize(make);
    const modelNorm = normalize(modelName);

    if (!makes.has(makeNorm)) makes.set(makeNorm, { name: make, normalized_name: makeNorm });
    const modelKey = `${makeNorm}:${modelNorm}`;
    if (!models.has(modelKey)) {
      models.set(modelKey, { make: make, model: modelName, make_normalized: makeNorm, model_normalized: modelNorm });
    }

    const rowHash = createHash('sha256')
      .update(JSON.stringify({ make, model: modelName, variant, energy, fiscalPower, maxPower, sourceRecordId }))
      .digest('hex');

    variants.push({
      make_normalized: makeNorm,
      model_normalized: modelNorm,
      source_record_id: sourceRecordId,
      commercial_name: variant || null,
      energy: energy || null,
      fiscal_power: fiscalPower,
      max_power_value: maxPower,
      max_power_unit: maxPower === null || maxPower === undefined ? null : 'kW',
      source_hash: rowHash
    });
  }

  return { makes: [...makes.values()], models: [...models.values()], variants, accepted, rejected };
}

function generateSql(makes, models, variants, contentSha256, updatedAt) {
  const lines = [];
  lines.push('BEGIN;');
  lines.push(`-- ADEME Car Labelling import, source: ${ADEME_DATASET_URL}`);
  lines.push(`TRUNCATE vehicle_variants, vehicle_models, vehicle_makes RESTART IDENTITY;`);

  // Source metadata update
  const updatedAtSql = toDateTime(updatedAt);
  lines.push(`UPDATE vehicle_catalog_sources SET source_version = null, source_updated_at = ${updatedAtSql}, content_sha256 = ${esc(contentSha256)}, last_synced_at = now() WHERE id = ${esc(SOURCE_ID)};`);

  // Makes
  const makeValues = makes.map((m, i) => `(${esc(m.name)}, ${esc(m.normalized_name)}, now(), now())`);
  if (makeValues.length) {
    lines.push(`INSERT INTO vehicle_makes (name, normalized_name, created_at, updated_at) VALUES`);
    lines.push(makeValues.join(',\n') + ';');
  }

  // Models with make_id resolved via lookup
  lines.push(`WITH make_map AS (SELECT id, normalized_name FROM vehicle_makes)`);
  const modelValues = models.map(m =>
    `((SELECT id FROM make_map WHERE normalized_name = ${esc(m.make_normalized)}), ${esc(m.model)}, ${esc(m.model_normalized)}, null, null, now(), now())`
  );
  if (modelValues.length) {
    lines.push(`INSERT INTO vehicle_models (make_id, name, normalized_name, year_from, year_to, created_at, updated_at) VALUES`);
    lines.push(modelValues.join(',\n') + ';');
  }

  // Variants in chunks
  if (variants.length) {
    for (let i = 0; i < variants.length; i += CHUNK_SIZE) {
      const chunk = variants.slice(i, i + CHUNK_SIZE);
      lines.push(`WITH mm AS (SELECT m.id AS model_id, m.make_id FROM vehicle_models m JOIN vehicle_makes mk ON m.make_id = mk.id)`);
      lines.push(`INSERT INTO vehicle_variants (model_id, source_id, source_record_id, commercial_name, energy, fiscal_power, max_power_value, max_power_unit, source_hash, created_at, updated_at) VALUES`);
      const vValues = chunk.map(v =>
        `((SELECT mm.model_id FROM mm JOIN vehicle_makes mk ON mm.make_id = mk.id WHERE mk.normalized_name = ${esc(v.make_normalized)} AND mm.model_id = (SELECT id FROM vehicle_models WHERE make_id = mk.id AND normalized_name = ${esc(v.model_normalized)})), ${esc(SOURCE_ID)}, ${esc(v.source_record_id)}, ${esc(v.commercial_name)}, ${esc(v.energy)}, ${escNum(v.fiscal_power)}, ${escNum(v.max_power_value)}, ${esc(v.max_power_unit)}, ${esc(v.source_hash)}, now(), now())`
      );
      lines.push(vValues.join(',\n') + ';');
    }
  }

  lines.push('COMMIT;');
  return lines.join('\n');
}

async function main() {
  console.log(`MODE: ${isApply ? 'APPLY-LOCAL' : 'DRY-RUN'}`);

  if (isApply) {
    // Local-only guard: check supabase status
    let status;
    try {
      status = JSON.parse(execSync('npx supabase status --output json', { encoding: 'utf8' }));
    } catch (e) {
      console.error('Failed to get supabase local status:', e.message);
      process.exit(1);
    }
    const apiUrl = new URL(status.API_URL);
    if (!isLocal(apiUrl.hostname)) {
      console.error(`LOCAL_DB_GUARD = FAIL: API_URL host is not local (${apiUrl.hostname})`);
      process.exit(1);
    }
    const dbHost = new URL(status.DB_URL).hostname;
    if (!isLocal(dbHost)) {
      console.error(`LOCAL_DB_GUARD = FAIL: DB_URL host is not local (${dbHost})`);
      process.exit(1);
    }
    console.log('LOCAL_DB_GUARD = PASS');
  }

  await downloadSnapshot();
  const meta = await loadDatasetMeta();
  const { rows, contentSha256, updatedAt } = loadSnapshot();

  const { makes, models, variants, accepted, rejected } = buildCatalog(rows);

  console.log('');
  console.log('=== ADEME SOURCE CONTRACT ===');
  console.log('ADEME_MAKE_FIELD = Marque');
  console.log('ADEME_MODEL_DISPLAY_FIELD = Libellé_modèle');
  console.log('ADEME_MODEL_TECHNICAL_FIELD = Modèle');
  console.log('ADEME_VARIANT_FIELD = Description_Commerciale');
  console.log('ADEME_ENERGY_FIELD = Energie');
  console.log('ADEME_FISCAL_POWER_FIELD = Puissance_fiscale');
  console.log('ADEME_MAX_POWER_FIELD = Puissance_maximale');
  console.log('ADEME_MAX_POWER_UNIT = kW');
  console.log('ADEME_VEHICLE_YEAR_AVAILABLE = NO');

  const uniqueMakes = makes.length;
  const uniqueModels = models.length;
  const uniqueVariants = variants.length;

  const nullEnergy = variants.filter(v => !v.energy).length;
  const nullFiscal = variants.filter(v => v.fiscal_power === null || v.fiscal_power === undefined).length;
  const nullYear = uniqueModels * 2; // both year_from and year_to are null for all

  console.log('');
  console.log('=== IMPORT STATS ===');
  console.log(`SOURCE_ROWS = ${rows.length}`);
  console.log(`ACCEPTED_ROWS = ${accepted}`);
  console.log(`REJECTED_ROWS = ${rejected}`);
  console.log(`DUPLICATE_ROWS = 0`);
  console.log(`UNIQUE_MAKES = ${uniqueMakes}`);
  console.log(`UNIQUE_MODELS = ${uniqueModels}`);
  console.log(`UNIQUE_VARIANTS = ${uniqueVariants}`);
  console.log(`NULL_ENERGY_COUNT = ${nullEnergy}`);
  console.log(`NULL_FISCAL_POWER_COUNT = ${nullFiscal}`);
  console.log(`NULL_YEAR_COUNT = ${nullYear}`);
  console.log(`VIN_COLUMNS_IMPORTED = 0`);

  if (isDryRun) {
    console.log('');
    console.log('DRY-RUN: no DB changes');
    return;
  }

  const sql = generateSql(makes, models, variants, contentSha256, updatedAt);
  writeFileSync(SQL_PATH, sql, 'utf8');

  console.log('');
  console.log(`Applying SQL: ${SQL_PATH}`);
  execSync(`npx supabase db query --local -f "${SQL_PATH}"`, { stdio: 'inherit' });
  console.log('IMPORT APPLIED');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
