const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REQUIRED_CSV_HEADERS } = require('../src/import-core');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'src', 'import-paypay-to-mfme.js');

function createTempDir(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paypay2mfjs-cli-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return tempDir;
}

function runCli(extraArgs) {
  return spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
}

test('dry-run integration prints summary counters', () => {
  const csvPath = path.join(repoRoot, 'samples', 'paypay_sample.csv');
  const result = runCli([`--csv=${csvPath}`, '--dry-run']);

  assert.equal(result.status, 0, result.stderr || 'dry-run should exit with code 0');
  assert.match(result.stdout, /ドライランモード/);
  assert.match(result.stdout, /合計=\d+/);
  assert.match(result.stdout, /解析失敗=\d+/);
  assert.match(result.stdout, /除外=\d+/);
  assert.match(result.stdout, /重複=\d+/);
  assert.match(result.stdout, /対象=\d+/);
});

test('dry-run integration treats valid header-only CSV as 0 target transactions', (t) => {
  const tempDir = createTempDir(t);
  const csvPath = path.join(tempDir, 'header-only.csv');
  const configPath = path.join(tempDir, 'config.json');
  fs.writeFileSync(csvPath, `${REQUIRED_CSV_HEADERS.join(',')}\n`, 'utf8');

  const result = runCli([`--csv=${csvPath}`, `--config=${configPath}`, '--dry-run']);

  assert.equal(result.status, 0, result.stderr || 'valid header-only dry-run should exit with code 0');
  assert.match(result.stdout, /ドライランモード/);
  assert.match(result.stdout, /合計=0/);
  assert.match(result.stdout, /解析失敗=0/);
  assert.match(result.stdout, /除外=0/);
  assert.match(result.stdout, /重複=0/);
  assert.match(result.stdout, /対象=0/);
});

test('CLI exits non-zero before browser launch when required CSV headers are missing', (t) => {
  const tempDir = createTempDir(t);
  const configPath = path.join(tempDir, 'config.json');
  const csvCases = [
    { name: 'invalid-header-only.csv', content: '取引日,取引先\n' },
    {
      name: 'invalid-header-with-rows.csv',
      content: '取引日,取引先\n2026/05/01 10:11:12,セブン-イレブン\n'
    }
  ];

  for (const csvCase of csvCases) {
    const csvPath = path.join(tempDir, csvCase.name);
    fs.writeFileSync(csvPath, csvCase.content, 'utf8');

    for (const dryRunFlag of ['--dry-run', null]) {
      const cliArgs = [`--csv=${csvPath}`, `--config=${configPath}`];
      if (dryRunFlag) {
        cliArgs.push(dryRunFlag);
      }
      const result = runCli(cliArgs);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /CSV の必須ヘッダーが不足しています/);
    }
  }
});

test('CLI exits non-zero before browser launch when CSV file is empty', (t) => {
  const tempDir = createTempDir(t);
  const csvPath = path.join(tempDir, 'empty.csv');
  const configPath = path.join(tempDir, 'config.json');
  fs.writeFileSync(csvPath, '', 'utf8');

  for (const dryRunFlag of ['--dry-run', null]) {
    const cliArgs = [`--csv=${csvPath}`, `--config=${configPath}`];
    if (dryRunFlag) {
      cliArgs.push(dryRunFlag);
    }
    const result = runCli(cliArgs);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CSV ファイルが空です/);
  }
});
