const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  buildRowFingerprint,
  resolveRowFingerprint,
  buildFirestoreDuplicatePayload,
  createDetector,
  DuplicateHistoryError,
  DuplicateHistorySaveError
} = require('../src/duplicate-detector');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'paypay2mfjs-'));
}

test('buildRowFingerprint returns Python-compatible hash for fixed vector', () => {
  const hash = buildRowFingerprint({
    dateText: '2026/05/01 10:11:12',
    content: '支払い',
    merchant: 'セブン-イレブン',
    outAmount: 1200,
    inAmount: 0,
    method: 'PayPay残高',
    paymentType: '通常',
    user: '本人'
  });

  assert.equal(hash, 'ce16ba725c3dce7eea82b8f15df33becec86c841c1942dbf8b16bba2e109953a');
});

test('buildFirestoreDuplicatePayload keeps Python-compatible key set and formats', () => {
  const payload = buildFirestoreDuplicatePayload({
    date: new Date(2026, 4, 1, 10, 11, 59),
    amount: 1200,
    merchant: 'セブン-イレブン',
    transactionId: null,
    direction: 'out',
    dateText: '2026/05/01 10:11:59',
    content: '支払い',
    method: 'PayPay残高',
    paymentType: '通常',
    user: '本人',
    rowFingerprint: 'abc123'
  });

  assert.deepEqual(Object.keys(payload).sort(), [
    'amount',
    'date_bucket',
    'datetime',
    'merchant',
    'row_fingerprint',
    'transaction_id'
  ]);
  assert.equal(payload.row_fingerprint, 'abc123');
  assert.equal(payload.date_bucket, '202605011011');
  assert.equal(payload.datetime, '2026-05-01T10:11:59');
  assert.equal(payload.transaction_id, '');
});

test('local detector writes only row_fingerprints to processed.json', async () => {
  const tempDir = createTempDir();
  const detector = await createDetector(
    {
      dryRun: false,
      duplicateDetection: {
        backend: 'local'
      }
    },
    tempDir
  );

  const tx = {
    date: new Date(2026, 4, 1, 10, 11, 12),
    amount: 1200,
    direction: 'out',
    merchant: 'セブン-イレブン',
    content: '支払い',
    method: 'PayPay残高',
    paymentType: '通常',
    user: '本人',
    dateText: '2026/05/01 10:11:12',
    transactionId: 'TXN-1',
    rowFingerprint: ''
  };

  assert.equal(await detector.isDuplicate(tx), false);
  await detector.markProcessed(tx);
  await detector.flush();

  const storePath = path.join(tempDir, 'logs', 'processed.json');
  const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['row_fingerprints']);
  assert.equal(Array.isArray(saved.row_fingerprints), true);
  assert.equal(saved.row_fingerprints.length, 1);
});

test('local detector backs up corrupted processed.json and throws', async () => {
  const tempDir = createTempDir();
  const logsDir = path.join(tempDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'processed.json'), '{broken', 'utf8');

  await assert.rejects(
    createDetector(
      {
        dryRun: false,
        duplicateDetection: {
          backend: 'local'
        }
      },
      tempDir
    ),
    DuplicateHistoryError
  );

  const files = fs.readdirSync(logsDir);
  assert.equal(files.includes('processed.json'), false);
  assert.equal(files.some((name) => name.startsWith('processed.corrupted_')), true);
});

test('resolveRowFingerprint prefers provided rowFingerprint over derived value', () => {
  const tx = {
    rowFingerprint: 'explicit-fingerprint',
    date: new Date(2026, 4, 1, 10, 11, 12),
    dateText: '2026/05/01 10:11:12',
    amount: 100,
    direction: 'out',
    merchant: 'A',
    content: 'B',
    method: 'C',
    paymentType: 'D',
    user: 'E'
  };

  assert.equal(resolveRowFingerprint(tx), 'explicit-fingerprint');
});

test('createDetector with gcloud backend requires gcloudCredentialsPath', async () => {
  await assert.rejects(
    createDetector(
      {
        dryRun: false,
        duplicateDetection: {
          backend: 'gcloud'
        }
      },
      process.cwd()
    ),
    DuplicateHistoryError
  );
});

test('createDetector falls back to local backend for unknown backend values', async () => {
  const tempDir = createTempDir();
  const detector = await createDetector(
    {
      dryRun: false,
      duplicateDetection: {
        backend: 'unknown_backend'
      }
    },
    tempDir
  );

  assert.equal(typeof detector.isDuplicate, 'function');
  assert.equal(typeof detector.markProcessed, 'function');
  assert.equal(typeof detector.flush, 'function');
});

test('local detector in dry-run mode does not persist processed.json', async () => {
  const tempDir = createTempDir();
  const detector = await createDetector(
    {
      dryRun: true,
      duplicateDetection: {
        backend: 'local'
      }
    },
    tempDir
  );

  const tx = {
    date: new Date(2026, 4, 1, 10, 11, 12),
    amount: 1200,
    direction: 'out',
    merchant: 'セブン-イレブン',
    content: '支払い',
    method: 'PayPay残高',
    paymentType: '通常',
    user: '本人',
    dateText: '2026/05/01 10:11:12',
    transactionId: 'TXN-1'
  };

  assert.equal(await detector.isDuplicate(tx), false);
  await detector.markProcessed(tx);
  assert.equal(await detector.isDuplicate(tx), false);
  await detector.flush();

  const storePath = path.join(tempDir, 'logs', 'processed.json');
  assert.equal(fs.existsSync(storePath), false);
});

test('local detector flush throws DuplicateHistorySaveError when rename fails', async (t) => {
  const tempDir = createTempDir();
  const detector = await createDetector(
    {
      dryRun: false,
      duplicateDetection: {
        backend: 'local'
      }
    },
    tempDir
  );

  const tx = {
    date: new Date(2026, 4, 1, 10, 11, 12),
    amount: 1200,
    direction: 'out',
    merchant: 'セブン-イレブン',
    content: '支払い',
    method: 'PayPay残高',
    paymentType: '通常',
    user: '本人',
    dateText: '2026/05/01 10:11:12',
    transactionId: 'TXN-ERR'
  };

  await detector.markProcessed(tx);

  const originalRenameSync = fs.renameSync;
  t.after(() => {
    fs.renameSync = originalRenameSync;
  });
  fs.renameSync = () => {
    throw new Error('simulated rename failure');
  };

  assert.throws(() => detector.flush(), DuplicateHistorySaveError);
});

test('local detector keeps dirty state after flush failure for retry', async (t) => {
  const tempDir = createTempDir();
  const detector = await createDetector(
    {
      dryRun: false,
      duplicateDetection: {
        backend: 'local'
      }
    },
    tempDir
  );

  const tx = {
    date: new Date(2026, 4, 1, 10, 11, 12),
    amount: 1200,
    direction: 'out',
    merchant: 'セブン-イレブン',
    content: '支払い',
    method: 'PayPay残高',
    paymentType: '通常',
    user: '本人',
    dateText: '2026/05/01 10:11:12',
    transactionId: 'TXN-RETRY'
  };

  await detector.markProcessed(tx);

  const originalRenameSync = fs.renameSync;
  t.after(() => {
    fs.renameSync = originalRenameSync;
  });
  fs.renameSync = () => {
    throw new Error('simulated rename failure');
  };

  assert.throws(() => detector.flush(), DuplicateHistorySaveError);
  assert.equal(detector.dirty, true);
});
