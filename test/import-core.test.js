const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  DIRECTION_IN,
  DIRECTION_OUT,
  DEFAULT_CATEGORY,
  parseArgs,
  parseJsonWithBomSupport,
  normalizeConfig,
  parseCsvLine,
  normalizeAmount,
  formatDateForForm,
  parseDate,
  resolveDirection,
  isRuleMatch,
  applyMapping,
  applyExclude,
  applyDuplicateDetection,
  loadCsv,
  normalizeAccountName
} = require('../src/import-core');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'paypay2mfjs-core-'));
}

test('parseArgs parses inline and separated options', () => {
  const args = parseArgs([
    '--csv=a.csv',
    '--config',
    'alt.json',
    '--headless',
    '--dry-run',
    '--keep-open',
    '--csv',
    'b.csv'
  ]);

  assert.equal(args.csv, 'b.csv');
  assert.equal(args.config, 'alt.json');
  assert.equal(args.headless, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.keepOpen, true);
});

test('parseJsonWithBomSupport parses JSON with and without BOM', () => {
  assert.deepEqual(parseJsonWithBomSupport('\uFEFF{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonWithBomSupport('{"b":2}'), { b: 2 });
});

test('normalizeConfig fills defaults and preserves valid nested settings', () => {
  const normalized = normalizeConfig({
    mfAccount: 'Main',
    excludePrefixes: ['X_'],
    mappingRules: [{ keyword: 'セブン', category: '食費' }],
    categoryMap: { 食費: '食費' },
    duplicateDetection: {
      backend: 'gcloud',
      databaseId: 'db1',
      localStorePath: 'logs/custom.json'
    },
    gcloudCredentialsPath: 'secrets/key.json',
    advanced: { screenshotOnError: 1 }
  });

  assert.equal(normalized.mfAccount, 'Main');
  assert.deepEqual(normalized.excludePrefixes, ['X_']);
  assert.equal(normalized.duplicateDetection.backend, 'gcloud');
  assert.equal(normalized.duplicateDetection.databaseId, 'db1');
  assert.equal(normalized.duplicateDetection.localStorePath, 'logs/custom.json');
  assert.equal(normalized.gcloudCredentialsPath, 'secrets/key.json');
  assert.equal(normalized.advanced.screenshotOnError, true);
});

test('parseCsvLine supports quoted commas and escaped quotes', () => {
  const values = parseCsvLine('a,"b,c","x""y"');
  assert.deepEqual(values, ['a', 'b,c', 'x"y']);
});

test('normalizeAmount handles commas, full-width commas and blanks', () => {
  assert.equal(normalizeAmount('1,234'), 1234);
  assert.equal(normalizeAmount('1，234'), 1234);
  assert.equal(normalizeAmount('-'), 0);
  assert.equal(normalizeAmount('ー'), 0);
  assert.equal(normalizeAmount(''), 0);
  assert.equal(normalizeAmount(null), 0);
});

test('parseDate and formatDateForForm handle valid date values', () => {
  const parsed = parseDate('2026/05/01 10:11:12');
  assert.equal(formatDateForForm(parsed), '2026/05/01');
  assert.throws(() => parseDate('2026-05-01 10:11:12'));
});

test('resolveDirection classifies in/out and rejects invalid pairs', () => {
  assert.deepEqual(resolveDirection(1200, 0), { amount: 1200, direction: DIRECTION_OUT });
  assert.deepEqual(resolveDirection(0, 900), { amount: 900, direction: DIRECTION_IN });
  assert.throws(() => resolveDirection(1, 1));
  assert.throws(() => resolveDirection(0, 0));
});

test('isRuleMatch supports contains starts_with and regex with direction gates', () => {
  const expenseTx = { merchant: 'セブン-イレブン', direction: DIRECTION_OUT };
  const incomeTx = { merchant: '給与振込', direction: DIRECTION_IN };

  assert.equal(isRuleMatch(expenseTx, { keyword: 'セブン' }), true);
  assert.equal(isRuleMatch(expenseTx, { matchMode: 'starts_with', keyword: 'セブン' }), true);
  assert.equal(isRuleMatch(expenseTx, { matchMode: 'regex', keyword: '^セブン-.+' }), true);
  assert.equal(isRuleMatch(expenseTx, { keyword: 'セブン', direction: 'income' }), false);
  assert.equal(isRuleMatch(incomeTx, { keyword: '給与', direction: 'income' }), true);
});

test('applyMapping applies highest priority rule and defaults category', () => {
  const mapped = applyMapping(
    [
      { merchant: 'セブン-イレブン', direction: DIRECTION_OUT },
      { merchant: '不明店舗', direction: DIRECTION_OUT }
    ],
    [
      { keyword: 'セブン', category: '雑費', priority: 1 },
      { keyword: 'セブン-イレブン', category: '食費', priority: 10 }
    ]
  );

  assert.equal(mapped[0].category, '食費');
  assert.equal(mapped[1].category, DEFAULT_CATEGORY);
});

test('applyExclude splits passed and excluded by transactionId prefixes', () => {
  const result = applyExclude(
    [
      { transactionId: 'PPCD_A_1' },
      { transactionId: 'OK_2' },
      { transactionId: null }
    ],
    ['PPCD_A_']
  );

  assert.equal(result.excluded.length, 1);
  assert.equal(result.passed.length, 2);
});

test('applyDuplicateDetection partitions by async detector response', async () => {
  const detector = {
    isDuplicate: async (tx) => tx.transactionId === 'dup'
  };

  const result = await applyDuplicateDetection(
    [
      { transactionId: 'dup' },
      { transactionId: 'new' }
    ],
    detector
  );

  assert.equal(result.duplicates.length, 1);
  assert.equal(result.passed.length, 1);
  assert.equal(result.passed[0].transactionId, 'new');
});

test('loadCsv loads valid rows and keeps parse failures per row', () => {
  const tempDir = createTempDir();
  const csvPath = path.join(tempDir, 'sample.csv');
  const csv = [
    '取引日,取引内容,取引先,出金金額（円）,入金金額（円）,取引方法,支払い区分,利用者,取引番号,海外出金金額,通貨',
    '2026/05/01 10:11:12,支払い,セブン-イレブン,1200,0,PayPay残高,通常,本人,TXN-1,-,-',
    '2026/05/01 10:11:12,支払い,,1200,0,PayPay残高,通常,本人,TXN-2,-,-'
  ].join('\n');
  fs.writeFileSync(csvPath, csv, 'utf8');

  const result = loadCsv(csvPath);

  assert.equal(result.transactions.length, 1);
  assert.equal(result.parseFailures.length, 1);
  assert.equal(result.transactions[0].category, DEFAULT_CATEGORY);
  assert.equal(result.transactions[0].memo, 'セブン-イレブン');
});

test('normalizeAccountName strips trailing yen suffix in parentheses', () => {
  assert.equal(normalizeAccountName('PayPay (1,234円)'), 'PayPay');
  assert.equal(normalizeAccountName('PayPay'), 'PayPay');
});
