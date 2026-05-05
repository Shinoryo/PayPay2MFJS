const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_BACKEND = 'local';
const DEFAULT_DATABASE_ID = '(default)';
const DEFAULT_LOGS_DIR = 'logs';
const PROCESSED_FILENAME = 'processed.json';

const KEY_ROW_FINGERPRINTS = 'row_fingerprints';
const KEY_ROW_FINGERPRINT = 'row_fingerprint';
const KEY_DATETIME = 'datetime';
const KEY_AMOUNT = 'amount';
const KEY_MERCHANT = 'merchant';
const KEY_DATE_BUCKET = 'date_bucket';
const KEY_TRANSACTION_ID = 'transaction_id';

const FIRESTORE_COLLECTION = 'paypay_transactions';

class DuplicateHistoryError extends Error {}
class DuplicateHistorySaveError extends Error {}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatCsvDateLike(date) {
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatLocalIso(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function buildDateBucket(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

function buildRowFingerprint({
  dateText,
  content,
  merchant,
  outAmount,
  inAmount,
  method,
  paymentType,
  user
}) {
  const raw = JSON.stringify([
    String(dateText || ''),
    String(content || ''),
    String(merchant || ''),
    String(outAmount || 0),
    String(inAmount || 0),
    String(method || ''),
    String(paymentType || ''),
    String(user || '')
  ]);

  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function resolveRowFingerprint(tx) {
  if (tx.rowFingerprint) {
    return tx.rowFingerprint;
  }

  const dateText = tx.dateText || formatCsvDateLike(tx.date);
  const outAmount = tx.direction === 'out' ? tx.amount : 0;
  const inAmount = tx.direction === 'in' ? tx.amount : 0;

  return buildRowFingerprint({
    dateText,
    content: tx.content || '',
    merchant: tx.merchant || '',
    outAmount,
    inAmount,
    method: tx.method || '',
    paymentType: tx.paymentType || '',
    user: tx.user || ''
  });
}

function buildFirestoreDuplicatePayload(tx) {
  return {
    [KEY_ROW_FINGERPRINT]: resolveRowFingerprint(tx),
    [KEY_DATETIME]: formatLocalIso(tx.date),
    [KEY_AMOUNT]: tx.amount,
    [KEY_MERCHANT]: tx.merchant,
    [KEY_DATE_BUCKET]: buildDateBucket(tx.date),
    [KEY_TRANSACTION_ID]: tx.transactionId || ''
  };
}

function defaultLocalStorePath(runtimeBaseDir) {
  return path.resolve(runtimeBaseDir, DEFAULT_LOGS_DIR, PROCESSED_FILENAME);
}

function normalizeDetectorConfig(userConfig) {
  const duplicateDetection = userConfig.duplicateDetection && typeof userConfig.duplicateDetection === 'object'
    ? userConfig.duplicateDetection
    : {};

  return {
    backend: String(duplicateDetection.backend || DEFAULT_BACKEND),
    databaseId: String(duplicateDetection.databaseId || DEFAULT_DATABASE_ID),
    localStorePath: duplicateDetection.localStorePath ? String(duplicateDetection.localStorePath) : null,
    gcloudCredentialsPath: userConfig.gcloudCredentialsPath ? String(userConfig.gcloudCredentialsPath) : null,
    dryRun: Boolean(userConfig.dryRun)
  };
}

function buildCorruptedBackupPath(storePath) {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}_${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}_${String(now.getUTCMilliseconds()).padStart(3, '0')}`;
  const parsed = path.parse(storePath);
  return path.join(parsed.dir, `${parsed.name}.corrupted_${stamp}${parsed.ext}`);
}

class LocalDuplicateDetector {
  constructor(storePath, dryRun) {
    this.storePath = storePath;
    this.dryRun = dryRun;
    this.data = { [KEY_ROW_FINGERPRINTS]: [] };
    this.rowFingerprints = new Set();
    this.dirty = false;

    this.load();
  }

  load() {
    if (!fs.existsSync(this.storePath)) {
      return;
    }

    try {
      const loaded = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      this.data = this.validateLoadedData(loaded);
      this.rowFingerprints = new Set(this.data[KEY_ROW_FINGERPRINTS]);
      this.dirty = false;
    } catch (error) {
      const backupPath = this.backupCorruptedStore();
      throw new DuplicateHistoryError(`processed.json が破損しており読み込めません。backup=${backupPath}`);
    }
  }

  validateLoadedData(loaded) {
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw new TypeError('processed.json のルートはオブジェクトである必要があります');
    }

    loaded[KEY_ROW_FINGERPRINTS] = loaded[KEY_ROW_FINGERPRINTS] || [];

    if (!Array.isArray(loaded[KEY_ROW_FINGERPRINTS])) {
      throw new TypeError('row_fingerprints は配列である必要があります');
    }

    for (const value of loaded[KEY_ROW_FINGERPRINTS]) {
      if (typeof value !== 'string') {
        throw new TypeError('row_fingerprints の要素は文字列である必要があります');
      }
    }

    return {
      [KEY_ROW_FINGERPRINTS]: loaded[KEY_ROW_FINGERPRINTS]
    };
  }

  backupCorruptedStore() {
    const backupPath = buildCorruptedBackupPath(this.storePath);
    fs.renameSync(this.storePath, backupPath);
    return backupPath;
  }

  isDuplicate(tx) {
    return this.rowFingerprints.has(resolveRowFingerprint(tx));
  }

  markProcessed(tx) {
    if (this.dryRun) {
      return;
    }

    const rowFingerprint = resolveRowFingerprint(tx);
    if (!this.rowFingerprints.has(rowFingerprint)) {
      this.rowFingerprints.add(rowFingerprint);
      this.data[KEY_ROW_FINGERPRINTS].push(rowFingerprint);
      this.dirty = true;
    }
  }

  flush() {
    if (this.dryRun || !this.dirty) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const tempPath = `${this.storePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempPath, this.storePath);
      this.dirty = false;
    } catch (error) {
      throw new DuplicateHistorySaveError('processed.json の保存に失敗しました');
    }
  }
}

class GCloudDuplicateDetector {
  constructor(client, dryRun) {
    this.client = client;
    this.dryRun = dryRun;
  }

  async isDuplicate(tx) {
    const rowFingerprint = resolveRowFingerprint(tx);
    const doc = await this.client.collection(FIRESTORE_COLLECTION).doc(rowFingerprint).get();
    return doc.exists;
  }

  async markProcessed(tx) {
    if (this.dryRun) {
      return;
    }

    const rowFingerprint = resolveRowFingerprint(tx);
    await this.client
      .collection(FIRESTORE_COLLECTION)
      .doc(rowFingerprint)
      .set(buildFirestoreDuplicatePayload(tx));
  }

  async flush() {
    // Firestore backend does not need an explicit flush.
  }
}

async function createDetector(userConfig, runtimeBaseDir) {
  const config = normalizeDetectorConfig(userConfig);

  if (config.backend === 'gcloud') {
    if (!config.gcloudCredentialsPath) {
      throw new DuplicateHistoryError('duplicateDetection.backend が gcloud の場合、gcloudCredentialsPath は必須です');
    }

    let Firestore;
    try {
      ({ Firestore } = require('@google-cloud/firestore'));
    } catch (error) {
      throw new DuplicateHistoryError("依存関係 '@google-cloud/firestore' が見つかりません。gcloud バックエンドを使うにはインストールしてください。");
    }

    const client = new Firestore({
      keyFilename: path.resolve(config.gcloudCredentialsPath),
      databaseId: config.databaseId
    });

    return new GCloudDuplicateDetector(client, config.dryRun);
  }

  const storePath = config.localStorePath
    ? path.resolve(config.localStorePath)
    : defaultLocalStorePath(runtimeBaseDir);

  return new LocalDuplicateDetector(storePath, config.dryRun);
}

module.exports = {
  buildRowFingerprint,
  resolveRowFingerprint,
  buildFirestoreDuplicatePayload,
  createDetector,
  DuplicateHistoryError,
  DuplicateHistorySaveError
};
