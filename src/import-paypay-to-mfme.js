const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { chromium } = require('playwright');
const {
  createDetector,
  DuplicateHistoryError,
  DuplicateHistorySaveError
} = require('./duplicate-detector');

const DIRECTION_IN = 'in';
const DIRECTION_OUT = 'out';
const DEFAULT_CATEGORY = 'Uncategorized';
const UTF8_BOM = '\uFEFF';

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

function loadJsonIfExists(filePath, fallback) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return fallback;
  }
  return parseJsonWithBomSupport(fs.readFileSync(resolved, 'utf8'));
}

function parseJsonWithBomSupport(text) {
  const normalized = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  return JSON.parse(normalized);
}

function normalizeConfig(userConfig) {
  const duplicateDetection = userConfig.duplicateDetection && typeof userConfig.duplicateDetection === 'object'
    ? userConfig.duplicateDetection
    : {};

  return {
    mfAccount: userConfig.mfAccount || 'PayPay',
    excludePrefixes: Array.isArray(userConfig.excludePrefixes) ? userConfig.excludePrefixes : ['PPCD_A_'],
    mappingRules: Array.isArray(userConfig.mappingRules) ? userConfig.mappingRules : [],
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

function loadRuntimeConfig(configPath) {
  const resolvedConfigPath = path.resolve(configPath);
  const userConfig = normalizeConfig(loadJsonIfExists(configPath, {}));
  const mfmeConfig = parseJsonWithBomSupport(
    fs.readFileSync(path.resolve(__dirname, 'mfme.config.json'), 'utf8')
  );
  return {
    userConfig,
    mfmeConfig,
    runtimeBaseDir: path.dirname(resolvedConfigPath)
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
  return Number(compact);
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
    return new RegExp(keyword).test(tx.merchant);
  }
  return tx.merchant.includes(keyword);
}

function applyMapping(transactions, mappingRules) {
  const prepared = [...mappingRules].sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  return transactions.map((tx) => {
    const matched = prepared.find((rule) => isRuleMatch(tx, rule));
    return {
      ...tx,
      category: matched ? String(matched.category || DEFAULT_CATEGORY) : DEFAULT_CATEGORY
    };
  });
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

async function launchBrowser(headless, mfmeConfig) {
  const context = await chromium.launchPersistentContext(path.resolve(mfmeConfig.profileDir), {
    channel: 'msedge',
    headless,
    viewport: { width: 1440, height: 960 }
  });

  context.setDefaultTimeout(mfmeConfig.timeoutsMs.action);
  context.setDefaultNavigationTimeout(mfmeConfig.timeoutsMs.navigation);
  const page = context.pages()[0] || (await context.newPage());
  return { context, page };
}

async function askForEnter(prompt) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function ensureLoggedIn(page, options, mfmeConfig) {
  await page.goto(mfmeConfig.urls.manualForm, { waitUntil: 'domcontentloaded' });

  const atSignIn = page.url().includes('/sign_in')
    || (await page.locator(mfmeConfig.selectors.loginForm).first().isVisible().catch(() => false));

  if (!atSignIn) {
    return;
  }

  if (options.headless) {
    throw new Error('headlessモードでは初回ログインを完了できません。--headless なしで一度実行してください。');
  }

  console.log('ログインが必要です。ブラウザでログイン後、Money Forwardのホーム/家計簿画面を開いてEnterを押してください。');
  await askForEnter('ログイン後にEnter: ');

  await page.goto(mfmeConfig.urls.manualForm, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/sign_in')) {
    throw new Error('ログインが完了していません。サインイン画面のままです。');
  }
}

function normalizeAccountName(text) {
  return String(text || '').trim().replace(/\s*\([^()]*円\)\s*$/, '');
}

async function selectAccount(page, selectors, mfAccount) {
  const options = page.locator(`${selectors.accountSelect} option`);
  const count = await options.count();
  let matchedValue = null;
  const normalized = normalizeAccountName(mfAccount);

  for (let i = 0; i < count; i += 1) {
    const option = options.nth(i);
    const optionText = normalizeAccountName(await option.innerText());
    if (optionText !== normalized) {
      continue;
    }
    matchedValue = await option.getAttribute('value');
    break;
  }

  if (!matchedValue) {
    throw new Error(`Money Forwardの口座選択に指定口座が見つかりません: ${mfAccount}`);
  }

  await page.selectOption(selectors.accountSelect, matchedValue);
}

async function selectCategory(page, selectors, categoryMap, middleCategory) {
  if (!middleCategory || middleCategory === DEFAULT_CATEGORY) {
    return;
  }

  const largeCategory = categoryMap[middleCategory];
  if (!largeCategory) {
    return;
  }

  await page.click(selectors.categoryDropdown);
  await page.locator(selectors.largeCategoryLink, { hasText: largeCategory }).first().hover();
  await page.locator(selectors.middleCategoryLink, { hasText: middleCategory }).first().click();
}

async function waitSubmitOutcome(page, mfmeConfig) {
  const successLocator = page.locator(mfmeConfig.selectors.submitSuccess);
  try {
    await successLocator.waitFor({ timeout: mfmeConfig.timeoutsMs.submit, state: 'visible' });
    const text = (await successLocator.first().innerText()).trim();
    if (text.includes('入力を保存しました') || text.length > 0) {
      return;
    }
  } catch {
    // Check explicit errors below.
  }

  for (const selector of mfmeConfig.submitErrorSelectors) {
    const errorLocator = page.locator(`${mfmeConfig.selectors.manualFormModal} ${selector}`).first();
    if (await errorLocator.isVisible().catch(() => false)) {
      const detail = ((await errorLocator.innerText().catch(() => '')) || '送信時の不明なエラー').trim();
      throw new Error(detail);
    }
  }

  throw new Error('登録結果を判定できませんでした');
}

async function importTransactions(page, transactions, runtimeConfig, options, detector) {
  const { userConfig, mfmeConfig } = runtimeConfig;
  const selectors = mfmeConfig.selectors;
  const summary = { success: 0, failed: 0, skipped: 0 };

  fs.mkdirSync(path.resolve(mfmeConfig.artifactsDir), { recursive: true });

  for (const tx of transactions) {
    try {
      await page.goto(mfmeConfig.urls.manualForm, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(selectors.openManualFormButton, { timeout: mfmeConfig.timeoutsMs.navigation });
      await page.click(selectors.openManualFormButton);
      await page.waitForSelector(selectors.manualFormModal, { timeout: mfmeConfig.timeoutsMs.action, state: 'visible' });

      if (tx.direction === DIRECTION_IN) {
        await page.click(`${selectors.manualFormModal} ${selectors.plusPaymentInput}`);
      } else {
        await page.click(`${selectors.manualFormModal} ${selectors.minusPaymentInput}`);
      }

      await page.fill(selectors.amountInput, String(tx.amount));
      await selectAccount(page, selectors, userConfig.mfAccount);
      await selectCategory(page, selectors, userConfig.categoryMap, tx.category);
      await page.fill(selectors.memoInput, tx.memo);
      await page.fill(selectors.dateInput, formatDateForForm(tx.date));
      await page.click(selectors.submitButton);

      await waitSubmitOutcome(page, mfmeConfig);
      try {
        await detector.markProcessed(tx);
      } catch (error) {
        throw new DuplicateHistorySaveError(
          `重複履歴の更新に失敗しました row=${tx.rowIndex}`
        );
      }
      summary.success += 1;
    } catch (error) {
      if (error instanceof DuplicateHistorySaveError || error instanceof DuplicateHistoryError) {
        throw error;
      }

      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[登録失敗] 行=${tx.rowIndex} 取引先=${tx.merchant} エラー=${message}`);

      if (userConfig.advanced.screenshotOnError) {
        const outPath = path.resolve(
          mfmeConfig.artifactsDir,
          `failed-row-${tx.rowIndex}-${Date.now()}.png`
        );
        await page.screenshot({ path: outPath, fullPage: true });
        console.error(`[成果物] スクリーンショット=${outPath}`);
      }
    }
  }

  if (options.keepOpen && !options.headless) {
    console.log('--keep-open が有効です。ブラウザを閉じるにはEnterを押してください。');
    await askForEnter('終了するにはEnter: ');
  }

  try {
    await detector.flush();
  } catch (error) {
    throw new DuplicateHistorySaveError('重複履歴の保存確定に失敗しました');
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.csv) {
    console.error('必須引数が不足しています: --csv=<path>');
    process.exitCode = 1;
    return;
  }

  let runtimeConfig;
  let csvResult;

  try {
    runtimeConfig = loadRuntimeConfig(args.config);
    csvResult = loadCsv(args.csv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const mapped = applyMapping(csvResult.transactions, runtimeConfig.userConfig.mappingRules);
  const filtered = applyExclude(mapped, runtimeConfig.userConfig.excludePrefixes);
  let deduplicated;

  try {
    const detector = await createDetector(
      {
        ...runtimeConfig.userConfig,
        dryRun: args.dryRun
      },
      runtimeConfig.runtimeBaseDir
    );
    deduplicated = await applyDuplicateDetection(filtered.passed, detector);

    if (args.dryRun) {
      console.log('ドライランモード');
      console.log(`合計=${csvResult.transactions.length}`);
      console.log(`解析失敗=${csvResult.parseFailures.length}`);
      console.log(`除外=${filtered.excluded.length}`);
      console.log(`重複=${deduplicated.duplicates.length}`);
      console.log(`対象=${deduplicated.passed.length}`);
      return;
    }

    let context;
    try {
      const browser = await launchBrowser(args.headless, runtimeConfig.mfmeConfig);
      context = browser.context;
      await ensureLoggedIn(browser.page, args, runtimeConfig.mfmeConfig);

      const summary = await importTransactions(
        browser.page,
        deduplicated.passed,
        runtimeConfig,
        args,
        detector
      );
      console.log(`成功=${summary.success}`);
      console.log(`失敗=${summary.failed}`);
      console.log(`スキップ=${summary.skipped + filtered.excluded.length + deduplicated.duplicates.length}`);
      console.log(`除外=${filtered.excluded.length}`);
      console.log(`重複=${deduplicated.duplicates.length}`);
      console.log(`解析失敗=${csvResult.parseFailures.length}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      if (context) {
        await context.close();
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
