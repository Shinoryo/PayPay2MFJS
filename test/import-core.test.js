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
  normalizeMappingRule,
  normalizeConfig,
  parseCsvLine,
  normalizeAmount,
  formatDateForForm,
  parseDate,
  resolveDirection,
  addDays,
  shouldDeferIncomeDate,
  applyIncomeDateAdjustments,
  isRuleMatch,
  applyMapping,
  resolveTransferAccounts,
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

test('normalizeMappingRule supports transfer aliases and boolean coercion', () => {
  const normalized = normalizeMappingRule({
    keyword: 'PayPayポイント運用',
    '振替？': 'true',
    '振替元・先': ' PayPayポイント '
  });

  assert.equal(normalized.isTransfer, true);
  assert.equal(normalized.transferAccount, 'PayPayポイント');
});

test('normalizeConfig normalizes transfer rules in mappingRules', () => {
  const normalized = normalizeConfig({
    mappingRules: [
      {
        keyword: 'PayPayポイント運用',
        isTransfer: true,
        transferAccount: 'PayPayポイント'
      }
    ]
  });

  assert.equal(normalized.mappingRules[0].isTransfer, true);
  assert.equal(normalized.mappingRules[0].transferAccount, 'PayPayポイント');
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

test('normalizeAmount handles negative numbers and decimals', () => {
  assert.equal(normalizeAmount('-1200'), -1200);
  assert.equal(normalizeAmount('1234.56'), 1234.56);
  assert.equal(normalizeAmount('-1,200'), -1200);
});

test('parseDate and formatDateForForm handle valid date values', () => {
  const parsed = parseDate('2026/05/01 10:11:12');
  assert.equal(formatDateForForm(parsed), '2026/05/01');
  assert.throws(() => parseDate('2026-05-01 10:11:12'));
});

test('addDays shifts dates across month boundaries', () => {
  const shifted = addDays(new Date(2026, 0, 31, 10, 11, 12), 30);

  assert.equal(formatDateForForm(shifted), '2026/03/02');
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

test('isRuleMatch rejects empty keyword values', () => {
  const tx = { merchant: 'セブン-イレブン', direction: DIRECTION_OUT };

  assert.equal(isRuleMatch(tx, { keyword: '' }), false);
  assert.equal(isRuleMatch(tx, { keyword: null }), false);
  assert.equal(isRuleMatch(tx, { keyword: undefined }), false);
});

test('isRuleMatch throws when regex pattern is invalid', () => {
  const tx = { merchant: 'セブン-イレブン', direction: DIRECTION_OUT };

  assert.throws(() => isRuleMatch(tx, { matchMode: 'regex', keyword: '([invalid' }));
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

test('applyMapping marks transfer rules and leaves category uncategorized', () => {
  const mapped = applyMapping(
    [
      { merchant: 'PayPayポイント運用', direction: DIRECTION_OUT }
    ],
    [
      {
        keyword: 'PayPayポイント運用',
        isTransfer: true,
        transferAccount: 'PayPayポイント',
        priority: 100
      }
    ]
  );

  assert.equal(mapped[0].isTransfer, true);
  assert.equal(mapped[0].transferAccount, 'PayPayポイント');
  assert.equal(mapped[0].category, DEFAULT_CATEGORY);
});

test('applyMapping throws when matched transfer rule is missing transferAccount', () => {
  assert.throws(() =>
    applyMapping(
      [{ merchant: 'PayPayポイント運用', direction: DIRECTION_OUT }],
      [{ keyword: 'PayPayポイント運用', isTransfer: true }]
    )
  );
});

test('applyMapping prefers higher-priority rule on transfer/category conflicts', () => {
  const mapped = applyMapping(
    [{ merchant: 'PayPayポイント運用', direction: DIRECTION_OUT }],
    [
      {
        keyword: 'PayPayポイント運用',
        category: '雑費',
        priority: 100
      },
      {
        keyword: 'PayPayポイント運用',
        isTransfer: true,
        transferAccount: 'PayPayポイント',
        priority: 200
      }
    ]
  );

  assert.equal(mapped[0].isTransfer, true);
  assert.equal(mapped[0].transferAccount, 'PayPayポイント');
  assert.equal(mapped[0].category, DEFAULT_CATEGORY);
});

test('applyMapping uses declaration order when priorities are equal', () => {
  const mapped = applyMapping(
    [{ merchant: 'PayPayポイント運用', direction: DIRECTION_OUT }],
    [
      {
        keyword: 'PayPayポイント運用',
        category: '雑費',
        priority: 100
      },
      {
        keyword: 'PayPayポイント運用',
        isTransfer: true,
        transferAccount: 'PayPayポイント',
        priority: 100
      }
    ]
  );

  assert.equal(mapped[0].isTransfer, false);
  assert.equal(mapped[0].transferAccount, null);
  assert.equal(mapped[0].category, '雑費');
});

test('resolveTransferAccounts maps expense and income around PayPay account', () => {
  assert.deepEqual(
    resolveTransferAccounts(
      { isTransfer: true, transferAccount: 'PayPayポイント', direction: DIRECTION_OUT, rowIndex: 1 },
      'PayPay'
    ),
    { fromAccount: 'PayPay', toAccount: 'PayPayポイント' }
  );

  assert.deepEqual(
    resolveTransferAccounts(
      { isTransfer: true, transferAccount: 'PayPayポイント', direction: DIRECTION_IN, rowIndex: 2 },
      'PayPay'
    ),
    { fromAccount: 'PayPayポイント', toAccount: 'PayPay' }
  );
});

test('resolveTransferAccounts rejects same-account transfers', () => {
  assert.throws(() =>
    resolveTransferAccounts(
      { isTransfer: true, transferAccount: 'PayPay', direction: DIRECTION_OUT, rowIndex: 1 },
      'PayPay'
    )
  );
});

test('applyMapping propagates regex syntax errors', () => {
  assert.throws(() =>
    applyMapping(
      [{ merchant: 'セブン-イレブン', direction: DIRECTION_OUT }],
      [{ matchMode: 'regex', keyword: '([invalid', category: '食費' }]
    )
  );
});

test('shouldDeferIncomeDate matches only targeted PayPay point income rows', () => {
  const baseTx = {
    direction: DIRECTION_IN,
    content: 'ポイント、残高の獲得',
    merchant: 'PayPayキャンペーン',
    method: 'PayPayポイント'
  };

  assert.equal(shouldDeferIncomeDate(baseTx), true);
  assert.equal(shouldDeferIncomeDate({ ...baseTx, merchant: 'ワイモバイル' }), false);
  assert.equal(shouldDeferIncomeDate({ ...baseTx, merchant: 'Yahoo!ズバトク' }), false);
  assert.equal(shouldDeferIncomeDate({ ...baseTx, direction: DIRECTION_OUT }), false);
  assert.equal(shouldDeferIncomeDate({ ...baseTx, content: '支払い' }), false);
  assert.equal(shouldDeferIncomeDate({ ...baseTx, method: 'PayPay残高' }), false);
});

test('applyIncomeDateAdjustments shifts only targeted income dates and keeps dateText', () => {
  const originalDate = new Date(2026, 4, 1, 10, 11, 12);
  const transactions = [
    {
      date: originalDate,
      dateText: '2026/05/01 10:11:12',
      direction: DIRECTION_IN,
      content: 'ポイント、残高の獲得',
      merchant: 'PayPayキャンペーン',
      method: 'PayPayポイント'
    },
    {
      date: originalDate,
      dateText: '2026/05/01 10:11:12',
      direction: DIRECTION_IN,
      content: 'ポイント、残高の獲得',
      merchant: 'ワイモバイル',
      method: 'PayPayポイント'
    }
  ];

  const adjusted = applyIncomeDateAdjustments(transactions);

  assert.equal(formatDateForForm(adjusted[0].date), '2026/05/31');
  assert.equal(adjusted[0].dateText, '2026/05/01 10:11:12');
  assert.notEqual(adjusted[0].date, originalDate);
  assert.equal(adjusted[1].date, originalDate);
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

test('loadCsv reads BOM-prefixed CSV fixture file', () => {
  const csvPath = path.resolve(__dirname, '../samples/paypay_sample_bom.csv');
  const result = loadCsv(csvPath);

  assert.equal(result.parseFailures.length, 0);
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].merchant, 'Mos Burger');
  assert.equal(result.transactions[1].merchant, 'giftee');
});

test('normalizeAccountName strips trailing yen suffix in parentheses', () => {
  assert.equal(normalizeAccountName('PayPay (1,234円)'), 'PayPay');
  assert.equal(normalizeAccountName('PayPay'), 'PayPay');
});

test('loadCsv throws when CSV file does not exist', () => {
  assert.throws(
    () => loadCsv('/nonexistent/path/missing.csv'),
    (err) => err instanceof Error
  );
});
