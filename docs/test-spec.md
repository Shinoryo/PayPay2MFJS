# テスト仕様書

## 1. 目的

- PayPay CSV 取り込み処理の回帰を防ぎ、境界条件と失敗系の挙動を安定して保証する。
- とくに不正regex、空keyword、BOM付きCSV、重複履歴flush失敗の仕様を明文化する。

## 2. 範囲

- 対象レイヤー: unit test / integration test / smoke test
- 主対象モジュール:
- src/import-core.js
- src/duplicate-detector.js
- src/import-paypay-to-mfme.js（smoke の入口確認）

## 3. テスト観点

| 観点ID | 観点 | 対象関数 | 期待挙動 |
| ---- | ---- | ---- | ---- |
| TC-REGEX-01 | regex正常系 | isRuleMatch | 有効regexでtrue/false判定 |
| TC-REGEX-02 | regex不正系 | isRuleMatch / applyMapping | 不正regexは例外を送出（現状仕様） |
| TC-KW-01 | 空keyword | isRuleMatch | 空文字/null/undefinedはfalse |
| TC-CSV-01 | BOM付きCSV実体 | loadCsv | BOMを除去して正常に2件読込 |
| TC-DUP-01 | flush正常系 | LocalDuplicateDetector.flush | processed.json保存成功 |
| TC-DUP-02 | flush失敗系 | LocalDuplicateDetector.flush | DuplicateHistorySaveError送出 |
| TC-DUP-03 | flush失敗後再試行性 | LocalDuplicateDetector.flush | dirty=true維持 |

## 4. ケース一覧

### 4.1 import-core

| ケースID | テスト名（node:test） | 前提 | 入力 | 期待結果 |
| ---- | ---- | ---- | ---- | ---- |
| TC-REGEX-02A | isRuleMatch throws when regex pattern is invalid | merchantが存在 | matchMode=regex, keyword="([invalid" | Errorがthrowされる |
| TC-REGEX-02B | applyMapping propagates regex syntax errors | 対象transaction1件 | mappingRulesに不正regexを含む | Errorがthrowされる |
| TC-KW-01A | isRuleMatch rejects empty keyword values | merchantが存在 | keyword=""/null/undefined | すべてfalse |
| TC-CSV-01A | loadCsv reads BOM-prefixed CSV fixture file | samples/paypay_sample_bom.csv が存在 | loadCsv(fixturePath) | parseFailures=0, transactions=2 |

### 4.2 duplicate-detector

| ケースID | テスト名（node:test） | 前提 | 入力 | 期待結果 |
| ---- | ---- | ---- | ---- | ---- |
| TC-DUP-02A | local detector flush throws DuplicateHistorySaveError when rename fails | markProcessed済み | fs.renameSyncを失敗モック | DuplicateHistorySaveError |
| TC-DUP-03A | local detector keeps dirty state after flush failure for retry | markProcessed済み | flush失敗後のdirty参照 | dirty=true |

## 5. テストデータ

- 固定fixture:
- samples/paypay_sample.csv
- samples/paypay_sample_bom.csv（UTF-8 BOM付き）
- 一時ファイル:
- test/import-core.test.js 内で作成する sample.csv

## 6. 実行手順

1. 依存関係をクリーンインストールする: npm ci
2. ユニット/統合テストを実行する: npm test
3. smokeを実行する: npm run smoke:dry-run

## 7. 受け入れ基準

- 追加した観点（TC-REGEX-02, TC-KW-01, TC-CSV-01, TC-DUP-02, TC-DUP-03）を満たすテストが全て成功する。
- dry-run の既存挙動（高速・副作用最小）が維持される。
- 仕様変更なし（invalid regex は例外送出のまま）。
