const fs = require('node:fs');
const path = require('node:path');

const DIRECTION_IN = 'in';
const DIRECTION_OUT = 'out';
const DEFAULT_CATEGORY = 'Uncategorized';
const UTF8_BOM = '\uFEFF';
const DEFERRED_INCOME_DAYS = 30;
const DEFERRED_INCOME_CONTENT = 'ポイント、残高の獲得';
const DEFERRED_INCOME_METHOD = 'PayPayポイント';
const DEFERRED_INCOME_EXCLUDED_MERCHANTS = new Set([
  'ワイモバイル',
  'Yahoo!ズバトク'
]);

function parseArgs(argv) {
  const args = {
    csv: undefined,
    config: 'config.json',
    headless: false,
    dryRun: false,
    keepOpen: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--headless') {
      args.headless = true;
      continue;
    }
    if (current === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (current === '--keep-open') {
      args.keepOpen = true;
      continue;
    }

    const csvEq = current.match(/^--csv=(.+)$/);
    if (csvEq) {
      args.csv = csvEq[1];
      continue;
    }
    if (current === '--csv') {
      args.csv = argv[index + 1];
      index += 1;
      continue;
    }

    const configEq = current.match(/^--config=(.+)$/);
    if (configEq) {
      args.config = configEq[1];
      continue;
    }
    if (current === '--config') {
      args.config = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return args;
}

function parseJsonWithBomSupport(text) {
  const normalized = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  return JSON.parse(normalized);
}

function normalizeMappingRule(rule) {
  const normalizedRule = rule && typeof rule === 'object' ? rule : {};
  const rawIsTransfer = normalizedRule.isTransfer ?? normalizedRule['振替？'];
  const rawTransferAccount = normalizedRule.transferAccount ?? normalizedRule['振替元・先'];
  const transferAccount = typeof rawTransferAccount === 'string' ? rawTransferAccount.trim() : '';

  return {
    ...normalizedRule,
    isTransfer: rawIsTransfer === true || String(rawIsTransfer || '').trim().toLowerCase() === 'true',
    transferAccount: transferAccount || null
  };
}

function normalizeConfig(userConfig) {
  const duplicateDetection = userConfig.duplicateDetection && typeof userConfig.duplicateDetection === 'object'
    ? userConfig.duplicateDetection
    : {};

  return {
    mfAccount: userConfig.mfAccount || 'PayPay',
    excludePrefixes: Array.isArray(userConfig.excludePrefixes) ? userConfig.excludePrefixes : ['PPCD_A_'],
    mappingRules: Array.isArray(userConfig.mappingRules)
      ? userConfig.mappingRules.map((rule) => normalizeMappingRule(rule))
      : [],
    categoryMap: userConfig.categoryMap && typeof userConfig.categoryMap === 'object' ? userConfig.categoryMap : {},
    duplicateDetection: {
      backend: duplicateDetection.backend || 'local',
      databaseId: duplicateDetection.databaseId || '(default)',
      localStorePath: duplicateDetection.localStorePath || null
    },
    gcloudCredentialsPath: userConfig.gcloudCredentialsPath || null,
    advanced: {
      screenshotOnError: Boolean(userConfig.advanced && userConfig.advanced.screenshotOnError)
    }
  };
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
}

function normalizeAmount(value) {
  if (value == null) {
    return 0;
  }
  const raw = String(value).trim();
  if (!raw || raw === '-' || raw === 'ー') {
    return 0;
  }
  const compact = raw.split(',').join('').split('，').join('');
  const amount = Number(compact);
  if (!Number.isFinite(amount)) {
    throw new Error(`金額形式が不正です: ${value}`);
  }
  return amount;
}

function formatDateForForm(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function parseDate(raw) {
  const match = String(raw).trim().match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(`日付形式が不正です: ${raw}`);
  }

  const [, year, month, day, hour, minute, second] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function resolveDirection(outAmount, inAmount) {
  if (outAmount > 0 && inAmount > 0) {
    throw new Error('出金金額と入金金額の両方が正の値です');
  }
  if (outAmount === 0 && inAmount === 0) {
    throw new Error('出金金額と入金金額の両方が0です');
  }
  if (outAmount > 0) {
    return { amount: outAmount, direction: DIRECTION_OUT };
  }
  return { amount: inAmount, direction: DIRECTION_IN };
}

function addDays(date, days) {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

function shouldDeferIncomeDate(tx) {
  return tx.direction === DIRECTION_IN
    && tx.content === DEFERRED_INCOME_CONTENT
    && tx.method === DEFERRED_INCOME_METHOD
    && !DEFERRED_INCOME_EXCLUDED_MERCHANTS.has(tx.merchant);
}

function applyIncomeDateAdjustments(transactions) {
  return transactions.map((tx) => {
    if (!shouldDeferIncomeDate(tx)) {
      return tx;
    }

    return {
      ...tx,
      date: addDays(tx.date, DEFERRED_INCOME_DAYS)
    };
  });
}

function isRuleMatch(tx, rule) {
  const mode = rule.matchMode || 'contains';
  const direction = rule.direction || 'any';

  if (direction === 'income' && tx.direction !== DIRECTION_IN) {
    return false;
  }
  if (direction === 'expense' && tx.direction !== DIRECTION_OUT) {
    return false;
  }

  const keyword = String(rule.keyword || '');
  if (!keyword) {
    return false;
  }

  if (mode === 'starts_with') {
    return tx.merchant.startsWith(keyword);
  }
  if (mode === 'regex') {
    let re;
    try {
      re = new RegExp(keyword);
    } catch {
      throw new Error(`mappingRules の regex パターンが不正です: "${keyword}"`);
    }
    return re.test(tx.merchant);
  }
  return tx.merchant.includes(keyword);
}

function applyMapping(transactions, mappingRules) {
  const prepared = mappingRules
    .map((rule) => normalizeMappingRule(rule))
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));

  return transactions.map((tx) => {
    const matched = prepared.find((rule) => isRuleMatch(tx, rule));

    if (matched && matched.isTransfer && !matched.transferAccount) {
      throw new Error(`振替ルールに transferAccount がありません: "${matched.keyword}"`);
    }

    return {
      ...tx,
      category: matched && !matched.isTransfer ? String(matched.category || DEFAULT_CATEGORY) : DEFAULT_CATEGORY,
      isTransfer: Boolean(matched && matched.isTransfer),
      transferAccount: matched && matched.isTransfer ? matched.transferAccount : null
    };
  });
}

function resolveTransferAccounts(tx, mfAccount) {
  if (!tx || !tx.isTransfer) {
    throw new Error('振替ではない取引に振替口座解決は使用できません');
  }

  const payPayAccount = normalizeAccountName(mfAccount);
  const counterpartyAccount = normalizeAccountName(tx.transferAccount);

  if (!counterpartyAccount) {
    let label;
    if (tx.direction === DIRECTION_IN) {
      label = '振替元口座';
    } else if (tx.direction === DIRECTION_OUT) {
      label = '振替先口座';
    } else {
      label = '振替相手口座';
    }
    throw new Error(`${label}が指定されていません row=${tx.rowIndex}`);
  }

  const resolved = tx.direction === DIRECTION_OUT
    ? { fromAccount: payPayAccount, toAccount: counterpartyAccount }
    : { fromAccount: counterpartyAccount, toAccount: payPayAccount };

  if (resolved.fromAccount === resolved.toAccount) {
    throw new Error(`振替元と振替先に同じ口座は指定できません: ${resolved.fromAccount}`);
  }

  return resolved;
}

function applyExclude(transactions, prefixes) {
  const passed = [];
  const excluded = [];

  for (const tx of transactions) {
    const tid = tx.transactionId || '';
    if (prefixes.some((prefix) => tid.startsWith(prefix))) {
      excluded.push(tx);
    } else {
      passed.push(tx);
    }
  }

  return { passed, excluded };
}

async function applyDuplicateDetection(transactions, detector) {
  const passed = [];
  const duplicates = [];

  for (const tx of transactions) {
    if (await detector.isDuplicate(tx)) {
      duplicates.push(tx);
      continue;
    }
    passed.push(tx);
  }

  return { passed, duplicates };
}

function loadCsv(csvPath) {
  const rawText = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const text = rawText.startsWith(UTF8_BOM) ? rawText.slice(1) : rawText;
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { transactions: [], parseFailures: [] };
  }

  const headers = parseCsvLine(lines[0]);
  const parseFailures = [];
  const transactions = [];

  for (let index = 1; index < lines.length; index += 1) {
    const rowNumber = index + 1;
    try {
      const cells = parseCsvLine(lines[index]);
      const row = {};
      headers.forEach((header, col) => {
        row[header] = cells[col] ?? '';
      });

      const outAmount = normalizeAmount(row['出金金額（円）']);
      const inAmount = normalizeAmount(row['入金金額（円）']);
      const { amount, direction } = resolveDirection(outAmount, inAmount);
      const merchant = String(row['取引先'] || '').trim();
      if (!merchant) {
        throw new Error('取引先は必須です');
      }

      const foreign = String(row['海外出金金額'] || '-').trim();
      const currency = String(row['通貨'] || '-').trim();
      let memo = merchant;
      if (foreign !== '-' && foreign.length > 0) {
        memo = `${merchant} (外貨: ${foreign} ${currency})`;
      }

      transactions.push({
        rowIndex: index,
        date: parseDate(row['取引日']),
        dateText: String(row['取引日'] || '').trim(),
        amount,
        outAmount,
        inAmount,
        direction,
        memo,
        merchant,
        content: String(row['取引内容'] || '').trim(),
        method: String(row['取引方法'] || '').trim(),
        paymentType: String(row['支払い区分'] || '').trim(),
        user: String(row['利用者'] || '').trim(),
        rowFingerprint: '',
        category: DEFAULT_CATEGORY,
        isTransfer: false,
        transferAccount: null,
        transactionId: String(row['取引番号'] || '').trim() || null
      });
    } catch (error) {
      parseFailures.push({
        rowNumber,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { transactions, parseFailures };
}

function normalizeAccountName(text) {
  return String(text || '').trim().replace(/\s*\([^()]*円\)\s*$/, '');
}

module.exports = {
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
};
