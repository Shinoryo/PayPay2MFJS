const fs = require('node:fs');
const path = require('node:path');
const { Firestore } = require('@google-cloud/firestore');
const {
  createDetector,
  resolveRowFingerprint
} = require('../src/duplicate-detector');

function resolveCredentialsPath() {
  return process.env.PAYPAY2MF_GCLOUD_CREDENTIALS_PATH
    || process.env.GOOGLE_APPLICATION_CREDENTIALS
    || '';
}

async function main() {
  const credentialsPath = resolveCredentialsPath();
  const databaseId = process.env.PAYPAY2MF_GCLOUD_DATABASE_ID || '(default)';

  if (!credentialsPath || !fs.existsSync(path.resolve(credentialsPath))) {
    console.log('gcloud-e2e をスキップしました: PAYPAY2MF_GCLOUD_CREDENTIALS_PATH に有効なファイルを設定してください');
    return;
  }

  const detector = await createDetector(
    {
      dryRun: false,
      gcloudCredentialsPath: credentialsPath,
      duplicateDetection: {
        backend: 'gcloud',
        databaseId
      }
    },
    process.cwd()
  );

  const tx = {
    date: new Date(),
    dateText: '',
    amount: 123,
    direction: 'out',
    merchant: `gcloud-e2e-${Date.now()}`,
    content: 'gcloud e2e',
    method: 'test',
    paymentType: 'test',
    user: 'test',
    transactionId: null,
    rowFingerprint: ''
  };

  const rowFingerprint = resolveRowFingerprint(tx);

  const wasDuplicate = await detector.isDuplicate(tx);
  if (wasDuplicate) {
    throw new Error('検証用トランザクションが既に存在します。再実行してください');
  }

  await detector.markProcessed(tx);
  const nowDuplicate = await detector.isDuplicate(tx);
  if (!nowDuplicate) {
    throw new Error('markProcessed 実行後の gcloud 重複判定に失敗しました');
  }

  const firestore = new Firestore({
    keyFilename: path.resolve(credentialsPath),
    databaseId
  });

  await firestore.collection('paypay_transactions').doc(rowFingerprint).delete();
  console.log('gcloud-e2e 成功');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
