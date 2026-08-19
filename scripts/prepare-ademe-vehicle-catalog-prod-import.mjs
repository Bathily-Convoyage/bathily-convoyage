// ADEME vehicle catalog first Production import SQL planner.
// READ-ONLY preparation only. NEVER executes SQL.
//
// Usage (dry-run):
//   node scripts/prepare-ademe-vehicle-catalog-prod-import.mjs \
//     --snapshot <path> \
//     --manifest <path>
//
// Usage (generate SQL):
//   node scripts/prepare-ademe-vehicle-catalog-prod-import.mjs \
//     --snapshot <path> \
//     --manifest <path> \
//     --generate-sql <absolute-output-path>
//
// Forbidden options: --apply, --apply-prod, --execute, --run-prod, --push

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAndValidatePlan,
  loadAndVerifyManifest,
  loadAndVerifySnapshot,
  buildVehicleCatalog,
  validateCatalog,
  generateFirstProdImportSql,
  isPathInsideRepo,
  SOURCE_ID
} from './lib/vehicle-catalog-prod-import.mjs';

const PLAN_PATH = fileURLToPath(new URL('../data/vehicle-catalog/ademe-first-prod-import-plan.json', import.meta.url));

function showUsage() {
  console.log(`Usage:
  node scripts/prepare-ademe-vehicle-catalog-prod-import.mjs \\
    --snapshot <path> \\
    --manifest <path> \\
    [--generate-sql <absolute-output-path>]
`);
}

function exitError(msg) {
  console.error('ERROR:', msg);
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { generateSql: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--snapshot') {
      result.snapshot = args[++i];
    } else if (arg === '--manifest') {
      result.manifest = args[++i];
    } else if (arg === '--generate-sql') {
      result.generateSql = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      showUsage();
      process.exit(0);
    } else if (arg.startsWith('--apply') || arg.startsWith('--execute') || arg === '--run-prod' || arg === '--push') {
      exitError(`Forbidden option: ${arg}. This planner never executes SQL.`);
    } else if (arg.startsWith('--')) {
      exitError(`Unknown option: ${arg}`);
    }
  }
  return result;
}

async function main() {
  const args = parseArgs();

  if (!args.snapshot || !args.manifest) {
    showUsage();
    exitError('--snapshot and --manifest are required.');
  }

  const snapshotPath = resolve(args.snapshot);
  const manifestPath = resolve(args.manifest);

  const plan = loadAndValidatePlan(PLAN_PATH);
  const manifest = loadAndVerifyManifest(manifestPath, plan);
  const rows = loadAndVerifySnapshot(snapshotPath, plan);
  const catalog = buildVehicleCatalog(rows, plan);

  // Fail closed if anything differs from frozen contract
  validateCatalog(plan, catalog);

  // Generate SQL if requested
  let sqlPath = null;
  if (args.generateSql) {
    const outPath = resolve(args.generateSql);
    if (isPathInsideRepo(outPath)) {
      exitError('SQL output path must be outside the repository: ' + outPath);
    }
    const sql = generateFirstProdImportSql(plan, manifest, catalog);
    writeFileSync(outPath, sql, 'utf8');
    sqlPath = outPath;
  }

  // Dry-run report
  console.log('PLAN_VERSION=' + plan.plan_version);
  console.log('SOURCE_ID=' + SOURCE_ID);
  console.log('DATASET_ID=' + plan.dataset_id);
  console.log('DATASET_UPDATED_AT=' + plan.dataset_updated_at);
  console.log('SNAPSHOT_SHA256=' + plan.snapshot_sha256);
  console.log('SNAPSHOT_ROWS=' + plan.snapshot_rows);
  console.log('ACCEPTED_ROWS=' + catalog.accepted);
  console.log('REJECTED_ROWS=' + catalog.rejected);
  console.log('EXPECTED_MAKES=' + catalog.makes.length);
  console.log('EXPECTED_MODELS=' + catalog.models.length);
  console.log('EXPECTED_VARIANTS=' + catalog.variants.length);
  console.log('NULL_MAX_POWER_COUNT=' + catalog.maxPowerStats.null);
  console.log('SOURCE_ID_DUPLICATES=' + catalog.duplicateSourceIds.length);
  console.log('NORMALIZATION_COLLISIONS=' + (catalog.makeCollisions.length + catalog.modelCollisions.length));
  console.log('FK_FAILURES=0');
  console.log('TYPE_FAILURES=0');
  console.log('PRODUCTION_EXECUTION=DISABLED');
  if (sqlPath) {
    console.log('GENERATED_SQL_PATH=' + sqlPath);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
