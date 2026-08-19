// Unit tests for ADEME first Production import planner.
// Pure local tests: no network, no DB, no child process, no Production.

import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  normalizeVehicleValue,
  isNumeric,
  toNum,
  loadAndValidatePlan,
  loadAndVerifyManifest,
  loadAndVerifySnapshot,
  buildVehicleCatalog,
  validateCatalog,
  generateFirstProdImportSql,
  sha256File,
  isPathInsideRepo,
  SOURCE_ID
} from './lib/vehicle-catalog-prod-import.mjs';

const REPO_ROOT = resolve(process.cwd());

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    fail++;
  }
}

function makePlan(overrides = {}) {
  return {
    plan_version: 1,
    mode: 'first-production-import',
    source_id: SOURCE_ID,
    dataset_id: 'ademe-car-labelling',
    dataset_updated_at: '2026-08-14T23:00:19.792Z',
    license: 'Licence Ouverte / Open Licence',
    snapshot_sha256: 'sha256placeholder',
    snapshot_rows: 2,
    expected_accepted: 2,
    expected_rejected: 0,
    expected_makes: 1,
    expected_models: 2,
    expected_variants: 2,
    max_power_unit: 'kW',
    ...overrides
  };
}

function makeSnapshotRows() {
  return [
    {
      _id: 'id1',
      Marque: 'Renault',
      'Libellé_modèle': 'Clio',
      Modèle: 'Clio',
      Description_Commerciale: 'Clio IV 1.2',
      Energie: 'ESSENCE',
      Puissance_fiscale: 5,
      Puissance_maximale: 54
    },
    {
      _id: 'id2',
      Marque: 'Renault',
      'Libellé_modèle': 'Mégane',
      Modèle: 'Mégane',
      Description_Commerciale: 'Mégane IV 1.5 dCi',
      Energie: 'GAZOLE',
      Puissance_fiscale: 6,
      Puissance_maximale: 85
    }
  ];
}

function writeTemp(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'vc-test-'));
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

function cleanup(path) {
  try { rmSync(path, { recursive: true, force: true }); } catch {}
}

// 1. Normalization

test('normalization trims whitespace', () => {
  assert.equal(normalizeVehicleValue('  Renault  '), 'RENAULT');
});

test('normalization collapses whitespace', () => {
  assert.equal(normalizeVehicleValue('Renault  Clio'), 'RENAULT CLIO');
});

test('normalization uppercases', () => {
  assert.equal(normalizeVehicleValue('renault'), 'RENAULT');
});

test('normalization preserves accents (NFKC)', () => {
  assert.equal(normalizeVehicleValue('Citröen'), 'CITRÖEN');
});

test('normalization handles null', () => {
  assert.equal(normalizeVehicleValue(null), '');
});

// 2. Snapshot hash mismatch rejected

test('snapshot SHA mismatch rejected', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update('wrong').digest('hex');
  try {
    loadAndVerifySnapshot(path, plan);
    throw new Error('Expected error');
  } catch (err) {
    assert.match(err.message, /SHA256 mismatch/);
  } finally {
    cleanup(path);
  }
});

// 3. Row count mismatch rejected

test('row count mismatch rejected', () => {
  const plan = makePlan({ snapshot_rows: 99 });
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  try {
    loadAndVerifySnapshot(path, plan);
    throw new Error('Expected error');
  } catch (err) {
    assert.match(err.message, /row count mismatch/);
  } finally {
    cleanup(path);
  }
});

// 4. Missing field rejected

test('source contract missing field rejected', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  delete rows[0].Energie;
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  try {
    loadAndVerifySnapshot(path, plan);
    throw new Error('Expected error');
  } catch (err) {
    assert.match(
      err.message,
      /^Missing required field in snapshot schema: Energie$/
    );
  } finally {
    cleanup(path);
  }
});

// 5. Manifest mismatch rejected

test('manifest datasetId mismatch rejected', () => {
  const plan = makePlan();
  const manifest = { datasetId: 'wrong', datasetUpdatedAt: plan.dataset_updated_at, rowCount: plan.snapshot_rows, snapshotSha256: plan.snapshot_sha256 };
  const path = writeTemp('manifest.json', JSON.stringify(manifest));
  try {
    loadAndVerifyManifest(path, plan);
    throw new Error('Expected error');
  } catch (err) {
    assert.match(err.message, /datasetId mismatch/);
  } finally {
    cleanup(path);
  }
});

test('manifest updatedAt mismatch rejected', () => {
  const plan = makePlan();
  const manifest = { datasetId: plan.dataset_id, datasetUpdatedAt: 'wrong', rowCount: plan.snapshot_rows, snapshotSha256: plan.snapshot_sha256 };
  const path = writeTemp('manifest.json', JSON.stringify(manifest));
  try {
    loadAndVerifyManifest(path, plan);
    throw new Error('Expected error');
  } catch (err) {
    assert.match(err.message, /datasetUpdatedAt mismatch/);
  } finally {
    cleanup(path);
  }
});

// 6. Duplicate source id rejected

test('duplicate source id rejected', () => {
  const plan = makePlan({ expected_rejected: 1, expected_accepted: 1, expected_models: 1, expected_variants: 1 });
  const rows = makeSnapshotRows();
  rows[1]._id = rows[0]._id;
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  plan.snapshot_rows = rows.length;
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  try {
    validateCatalog(plan, catalog);
    throw new Error('Expected error');
  } catch (err) {
    assert.match(err.message, /Duplicate source IDs/);
  } finally {
    cleanup(path);
  }
});

// 7. Normalization collision rejected when unsafe

test('normalization collision on make rejected', () => {
  const plan = makePlan({ expected_makes: 1, expected_models: 2 });
  const rows = makeSnapshotRows();
  rows[0].Marque = 'Renault';
  rows[1].Marque = 'RENAULT '; // same normalized
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  try {
    validateCatalog(plan, catalog);
    throw new Error('Expected error');
  } catch (err) {
    assert.match(err.message, /Make normalization collisions/);
  } finally {
    cleanup(path);
  }
});

// 8. Numeric validation

test('isNumeric accepts integer', () => {
  assert.equal(isNumeric(5), true);
});

test('isNumeric accepts decimal comma string', () => {
  assert.equal(isNumeric('5,5'), true);
});

test('isNumeric rejects non-numeric', () => {
  assert.equal(isNumeric('abc'), false);
});

test('toNum converts null to null', () => {
  assert.equal(toNum(null), null);
});

test('toNum converts decimal point', () => {
  assert.equal(toNum('5.5'), 5.5);
});

// 9. Null max power accepted

test('null max power accepted', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  rows[0]['Puissance_maximale'] = null;
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  assert.equal(catalog.variants[0].max_power_value, null);
  assert.equal(catalog.variants[0].max_power_unit, null);
  cleanup(path);
});

// 10. No synthetic year

test('no synthetic year generated', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  assert.equal(catalog.models.every(m => m.year_from === null && m.year_to === null), true);
  cleanup(path);
});

// 11. No VIN imported

test('no VIN in output', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(sql.includes('vin'), false);
  cleanup(path);
});

// 12. Correct catalog counts fixture

test('correct makes count fixture', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  assert.equal(catalog.makes.length, 1);
  cleanup(path);
});

test('correct models count fixture', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  assert.equal(catalog.models.length, 2);
  cleanup(path);
});

test('correct variants count fixture', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  assert.equal(catalog.variants.length, 2);
  cleanup(path);
});

// 13. Deterministic SQL

test('generated SQL is deterministic', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql1 = generateFirstProdImportSql(plan, {}, catalog);
  const sql2 = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(sql1, sql2);
  cleanup(path);
});

// 14-16. BEGIN, COMMIT present

test('BEGIN present', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.match(sql, /BEGIN;/);
  cleanup(path);
});

test('COMMIT present', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.match(sql, /COMMIT;/);
  cleanup(path);
});

// 17-23. No forbidden statements

test('no TRUNCATE', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(/\bTRUNCATE\b/i.test(sql), false);
  cleanup(path);
});

test('no DELETE FROM', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(/\bDELETE\s+FROM\b/i.test(sql), false);
  cleanup(path);
});

test('no DROP', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(/\bDROP\b/i.test(sql), false);
  cleanup(path);
});

test('no RESTART IDENTITY', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(/RESTART\s+IDENTITY/i.test(sql), false);
  cleanup(path);
});

test('no ALTER TABLE', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(/\bALTER\s+TABLE\b/i.test(sql), false);
  cleanup(path);
});

test('no GRANT', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(/\bGRANT\b/i.test(sql), false);
  cleanup(path);
});

test('no REVOKE', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(/\bREVOKE\b/i.test(sql), false);
  cleanup(path);
});

// 24. No credentials

test('no credentials in generated SQL', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(sql.includes('service_role'), false);
  assert.equal(sql.includes('anon key'), false);
  assert.equal(sql.includes('DATABASE_URL'), false);
  assert.equal(sql.includes('JWT'), false);
  cleanup(path);
});

// 25-27. ON CONFLICT present

test('makes ON CONFLICT present', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.match(sql, /ON CONFLICT \(normalized_name\)/);
  cleanup(path);
});

test('models ON CONFLICT present', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.match(sql, /ON CONFLICT \(make_id, normalized_name\)/);
  cleanup(path);
});

test('variants ON CONFLICT present', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.match(sql, /ON CONFLICT \(source_id, source_record_id\)/);
  cleanup(path);
});

// 28-30. Preconditions, postconditions, snapshot SHA assertion

test('preconditions present', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.match(sql, /vehicle_catalog_sources count must be 1/);
  assert.match(sql, /vehicle_makes must be empty for first import/);
  cleanup(path);
});

test('postconditions present', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.match(sql, /Postcondition failed/);
  cleanup(path);
});

test('snapshot SHA assertion present', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.match(sql, /Snapshot SHA assertion failed/);
  cleanup(path);
});

// 31. Output inside repo rejected

test('output path inside repo rejected', () => {
  const outPath = join(REPO_ROOT, 'tmp.sql');
  assert.equal(isPathInsideRepo(outPath), true);
});

test('output path outside repo allowed', () => {
  const outPath = resolve(tmpdir(), 'tmp.sql');
  assert.equal(isPathInsideRepo(outPath), false);
});

// 32-40. SQL literal escaping regression

test('apostrophe SQL literal escaping', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  rows[0].Description_Commerciale = "D'ARTAGNAN";
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(sql.includes("'D''ARTAGNAN'"), true);
  assert.equal(sql.includes("'D\\'ARTAGNAN'"), false);
  cleanup(path);
});

test('multiple apostrophes SQL literal escaping', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  rows[0].Description_Commerciale = "L'AVENTURE D'ALICE";
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(sql.includes("'L''AVENTURE D''ALICE'"), true);
  cleanup(path);
});

test('backslash preserved in SQL literal', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  rows[0].Description_Commerciale = "A\\B";
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(sql.includes("'A\\B'"), true);
  assert.equal(sql.includes("'A\\\\B'"), false);
  cleanup(path);
});

test('newline deterministic in SQL literal', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  rows[0].Description_Commerciale = "LINE1\nLINE2";
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  const sql2 = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(sql, sql2);
  assert.equal(sql.includes("'LINE1\nLINE2'"), true);
  cleanup(path);
});

test('NUL input rejected in SQL generation', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  rows[0].Description_Commerciale = "BAD\0X";
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  assert.throws(() => {
    generateFirstProdImportSql(plan, {}, catalog);
  }, /NUL character not allowed in SQL string literal/);
  cleanup(path);
});

test('SET LOCAL standard_conforming_strings present', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(sql.includes('SET LOCAL standard_conforming_strings = on;'), true);
  cleanup(path);
});

test('no backslash quote escaping in generated SQL', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  rows[0].Description_Commerciale = "can't don't";
  rows[1].Description_Commerciale = "A\\B";
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(sql.includes("\\'"), false);
  cleanup(path);
});

test('apostrophe escaping does not alter other characters', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  rows[0].Description_Commerciale = "T-ROC 17'' to 19''";
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(sql.includes("'T-ROC 17'''' to 19'''''"), true);
  assert.equal(sql.includes("\\'"), false);
  cleanup(path);
});

test('SQL literal escaping deterministic', () => {
  const plan = makePlan();
  const rows = makeSnapshotRows();
  rows[0].Description_Commerciale = "D'ARTAGNAN";
  rows[1].Description_Commerciale = "A\\B";
  const raw = JSON.stringify(rows);
  const path = writeTemp('snap.json', raw);
  plan.snapshot_sha256 = createHash('sha256').update(raw).digest('hex');
  const loaded = loadAndVerifySnapshot(path, plan);
  const catalog = buildVehicleCatalog(loaded, plan);
  const sql1 = generateFirstProdImportSql(plan, {}, catalog);
  const sql2 = generateFirstProdImportSql(plan, {}, catalog);
  assert.equal(sql1, sql2);
  cleanup(path);
});

// Summary
console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
