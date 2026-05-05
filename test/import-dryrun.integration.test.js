const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('dry-run integration prints summary counters', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const scriptPath = path.join(repoRoot, 'src', 'import-paypay-to-mfme.js');
  const csvPath = path.join(repoRoot, 'samples', 'paypay_sample.csv');

  const result = spawnSync(
    process.execPath,
    [scriptPath, `--csv=${csvPath}`, '--dry-run'],
    {
      cwd: repoRoot,
      encoding: 'utf8'
    }
  );

  assert.equal(result.status, 0, result.stderr || 'dry-run should exit with code 0');
  assert.match(result.stdout, /ドライランモード/);
  assert.match(result.stdout, /合計=\d+/);
  assert.match(result.stdout, /解析失敗=\d+/);
  assert.match(result.stdout, /除外=\d+/);
  assert.match(result.stdout, /重複=\d+/);
  assert.match(result.stdout, /対象=\d+/);
});
