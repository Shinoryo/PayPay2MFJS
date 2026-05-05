const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildRowFingerprint } = require('../src/duplicate-detector');

function parseArgs(argv) {
  const args = {
    csv: 'samples/paypay_sample.csv',
    pythonRepo: path.resolve(__dirname, '..', '..', 'PayPay2MF')
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const csvEq = current.match(/^--csv=(.+)$/);
    if (csvEq) {
      args.csv = csvEq[1];
      continue;
    }
    if (current === '--csv') {
      args.csv = argv[i + 1];
      i += 1;
      continue;
    }

    const repoEq = current.match(/^--python-repo=(.+)$/);
    if (repoEq) {
      args.pythonRepo = repoEq[1];
      continue;
    }
    if (current === '--python-repo') {
      args.pythonRepo = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return args;
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
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw === '-' || raw === 'ー') {
    return 0;
  }
  const compact = raw.split(',').join('').split('，').join('');
  return Number(compact);
}

function loadJsFingerprints(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return new Set();
  }

  const headers = parseCsvLine(lines[0]);
  const result = new Set();

  for (let i = 1; i < lines.length; i += 1) {
    const row = {};
    const cells = parseCsvLine(lines[i]);
    headers.forEach((header, idx) => {
      row[header] = cells[idx] || '';
    });

    const dateText = String(row['取引日'] || '').trim();
    const merchant = String(row['取引先'] || '').trim();
    const content = String(row['取引内容'] || '').trim();
    const method = String(row['取引方法'] || '').trim();
    const paymentType = String(row['支払い区分'] || '').trim();
    const user = String(row['利用者'] || '').trim();

    if (!dateText || !merchant) {
      continue;
    }

    const outAmount = normalizeAmount(row['出金金額（円）']);
    const inAmount = normalizeAmount(row['入金金額（円）']);
    if ((outAmount > 0 && inAmount > 0) || (outAmount === 0 && inAmount === 0)) {
      continue;
    }

    result.add(
      buildRowFingerprint({
        dateText,
        content,
        merchant,
        outAmount,
        inAmount,
        method,
        paymentType,
        user
      })
    );
  }

  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = path.resolve(args.csv);
  const pythonRepo = path.resolve(args.pythonRepo);
  const pythonScriptPath = path.resolve(__dirname, 'python_row_fingerprints.py');

  const jsSet = loadJsFingerprints(csvPath);

  const python = spawnSync(
    'python',
    [pythonScriptPath, csvPath, pythonRepo],
    { encoding: 'utf8' }
  );

  if (python.error) {
    console.error(`Python実行に失敗しました: ${python.error.message}`);
    process.exitCode = 2;
    return;
  }

  if (python.status !== 0) {
    console.error(python.stderr || python.stdout || 'Pythonスクリプトの実行に失敗しました');
    process.exitCode = 2;
    return;
  }

  const pySet = new Set(
    (python.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );

  const missingInPython = [...jsSet].filter((value) => !pySet.has(value));
  const missingInJs = [...pySet].filter((value) => !jsSet.has(value));

  console.log(`JS件数=${jsSet.size}`);
  console.log(`Python件数=${pySet.size}`);
  console.log(`Python側不足=${missingInPython.length}`);
  console.log(`JS側不足=${missingInJs.length}`);

  if (missingInPython.length > 0 || missingInJs.length > 0) {
    console.error('フィンガープリント集合の不一致を検出しました');
    if (missingInPython.length > 0) {
      console.error(`Python側不足サンプル=${missingInPython.slice(0, 5).join(',')}`);
    }
    if (missingInJs.length > 0) {
      console.error(`JS側不足サンプル=${missingInJs.slice(0, 5).join(',')}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('フィンガープリント集合は一致しています');
}

main();
