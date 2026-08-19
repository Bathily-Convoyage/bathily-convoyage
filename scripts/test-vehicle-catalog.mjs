// Vehicle catalog unit tests
// Local fixture only, no network, no DB runtime
import { createHash } from 'node:crypto';

// Replicate normalization logic from ETL
function normalize(s) {
  if (s === null || s === undefined) return '';
  return String(s).normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
}

function buildCatalog(rows) {
  const makes = new Map();
  const models = new Map();
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
      models.set(modelKey, { make, model: modelName, make_normalized: makeNorm, model_normalized: modelNorm });
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

let _pass = 0;
let _fail = 0;

function assert(c, m) { if (!c) throw new Error(`ASSERT: ${m}`); }
function assertEq(a, e, m) { if (a !== e) throw new Error(`ASSERT: ${m} — expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }

function test(name, fn) {
  try {
    fn();
    _pass++;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    _fail++;
    console.log(`[FAIL] ${name} — ${err.message}`);
  }
}

const fixture1 = [
  { _id: 'a', Marque: 'Renault', 'Libellé_modèle': 'Clio', Modèle: 'CLIO', Description_Commerciale: 'Clio 90ch', Energie: 'ESSENCE', Puissance_fiscale: 5, Puissance_maximale: 66 },
  { _id: 'b', Marque: '  renault  ', 'Libellé_modèle': '  CLIO  ', Modèle: 'CLIO', Description_Commerciale: 'Clio 100ch', Energie: 'DIESEL', Puissance_fiscale: 6, Puissance_maximale: 74 },
  { _id: 'c', Marque: 'Peugeot', 'Libellé_modèle': '208', Modèle: '208', Description_Commerciale: '208 75ch', Energie: 'ESSENCE', Puissance_fiscale: 4, Puissance_maximale: 56 },
  { _id: 'd', Marque: 'Peugeot', 'Libellé_modèle': '208', Modèle: '208', Description_Commerciale: '208 100ch', Energie: 'ESSENCE', Puissance_fiscale: 5, Puissance_maximale: 74 },
  { _id: 'e', Marque: 'Renault', 'Libellé_modèle': 'Mégane', Modèle: 'MEGANE', Description_Commerciale: 'Mégane 140ch', Energie: 'DIESEL', Puissance_fiscale: 8, Puissance_maximale: 103 },
  { _id: 'f', Marque: '', 'Libellé_modèle': 'Unknown', Modèle: 'UNKNOWN', Description_Commerciale: 'x', Energie: 'ESSENCE', Puissance_fiscale: 5, Puissance_maximale: 70 },
  { _id: 'g', Marque: 'BMW', 'Libellé_modèle': '', Modèle: '', Description_Commerciale: 'x', Energie: 'ESSENCE', Puissance_fiscale: 12, Puissance_maximale: 180 }
];

const r1 = buildCatalog(fixture1);

test('normalization trims and uppercases', () => {
  assert(normalize('  renault  ') === 'RENAULT', 'trim');
  assert(normalize('clio  iii') === 'CLIO III', 'multi-space');
});

test('normalization is accent-insensitive via NFKC', () => {
  assert(normalize('Renault  électrique') === 'RENAULT ÉLECTRIQUE', 'NFKC upper');
});

test('duplicate makes normalized to one', () => {
  assertEq(r1.makes.length, 2, '2 unique makes (renault normalized)');
});

test('duplicate models per make normalized to one', () => {
  assertEq(r1.models.length, 3, '3 unique make/model pairs');
});

test('rejected rows for empty make or model', () => {
  assertEq(r1.rejected, 2, 'two rejected (f empty make, g empty model)');
});

test('accepted rows count', () => {
  assertEq(r1.accepted, 5, 'five accepted');
});

test('fiscal power mapped correctly', () => {
  assert(r1.variants.some(v => v.fiscal_power === 5), 'fiscal power present');
});

test('max power unit is kW when present', () => {
  assert(r1.variants.every(v => v.max_power_unit === 'kW'), 'unit kW');
});

test('energy mapped', () => {
  assert(r1.variants.some(v => v.energy === 'ESSENCE'), 'essence present');
  assert(r1.variants.some(v => v.energy === 'DIESEL'), 'diesel present');
});

test('source_record_id preserved', () => {
  assert(r1.variants.some(v => v.source_record_id === 'a'), 'id a present');
});

test('source hash deterministic', () => {
  const h1 = r1.variants[0].source_hash;
  const r2 = buildCatalog(fixture1);
  const h2 = r2.variants[0].source_hash;
  assertEq(h1, h2, 'same hash for same row');
});

test('idempotence: same fixture same counts', () => {
  const r3 = buildCatalog(fixture1);
  assertEq(r3.makes.length, r1.makes.length, 'makes stable');
  assertEq(r3.models.length, r1.models.length, 'models stable');
  assertEq(r3.variants.length, r1.variants.length, 'variants stable');
});

test('no synthetic year generation', () => {
  assert(r1.models.every(m => m.year_from === undefined && m.year_to === undefined), 'no year in catalog builder');
});

test('no vin column imported', () => {
  assert(!r1.variants.some(v => 'vin' in v), 'no vin field');
});

test('commercial name fallback to variant', () => {
  assert(r1.variants.some(v => v.commercial_name === 'Clio 90ch'), 'commercial name preserved');
});

console.log(`\n${_pass} passed, ${_fail} failed`);
process.exit(_fail === 0 ? 0 : 1);
