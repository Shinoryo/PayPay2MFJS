# テスト仕様書

## 1. 目的

- PayPay CSV 取り込み処理の回帰を防ぎ、境界条件と失敗系の挙動を安定して保証する。
- とくに不正regex、空keyword、BOM付きCSV、振替ルール、重複履歴flush失敗の仕様を明文化する。

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
| TC-TR-01 | 振替ルール正規化 | normalizeConfig | isTransfer と transferAccount を正規化 |
| TC-TR-01C | 振替/カテゴリ衝突検出 | normalizeMappingRule / normalizeConfig | `isTransfer=true` と `category` を同時に指定した場合は例外を送出 |
| TC-TR-02 | 振替ルール適用 | applyMapping | category を使わず振替情報を付与 |
| TC-TR-03 | 振替口座解決 | resolveTransferAccounts | 入出金方向に応じて振替元・振替先を決定 |
| TC-TR-04 | 競合時の優先順位 | applyMapping | priority優先、同値は設定順で決定 |
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
| TC-TR-01A | normalizeConfig normalizes transfer rules in mappingRules | transfer ruleを含む設定 | isTransfer=true, transferAccountあり | 正規化後も値を保持 |
| TC-TR-01B | normalizeMappingRule supports transfer aliases and boolean coercion | 旧キーを含むrule | `振替？`=`true`, `振替元・先` あり | `isTransfer` と `transferAccount` に変換 |
| TC-TR-01C | normalizeMappingRule throws when isTransfer and category are both specified | ルールに両方指定 | isTransfer=true, categoryあり | 例外が投げられる |
| TC-TR-01D | normalizeMappingRule trims and lowercases isTransfer strings | ルールに旧キーまたは `isTransfer` が文字列で設定されている | `'振替？': 'true ' / '振替？': ' True' / isTransfer: ' FALSE '` | `isTransfer` は `trim()` + 小文字化で判定され、'true' 系は true、その他は false と扱われる |
| TC-TR-02A | applyMapping marks transfer rules and leaves category uncategorized | 対象transaction1件 | isTransfer=true のrule | isTransfer=true, category=Uncategorized |
| TC-TR-02B | applyMapping throws when matched transfer rule is missing transferAccount | 対象transaction1件 | transferAccountなしの振替rule | Errorがthrowされる |
| TC-TR-03A | resolveTransferAccounts maps expense and income around PayPay account | mfAccount=PayPay | expense/income の振替transaction | 振替元・振替先が期待通り |
| TC-TR-03B | resolveTransferAccounts rejects same-account transfers | mfAccountとtransferAccountが同一 | 振替transaction | Errorがthrowされる |
| TC-TR-04A | applyMapping prioritizes higher-priority transfer rule over category rule | 同一keywordで複数rule | transferとcategoryでpriority差あり | 高priorityのruleを採用 |
| TC-TR-04B | applyMapping uses declaration order when priorities are equal | 同一keywordで複数rule | transferとcategoryでpriority同値 | mappingRulesの上側ruleを採用 |

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
2. Markdown を lint する: npm run lint:md
3. ユニット/統合テストを実行する: npm test
4. smokeを実行する: npm run smoke:dry-run

## 7. 受け入れ基準

- 追加した観点（TC-REGEX-02, TC-KW-01, TC-CSV-01, TC-TR-01, TC-TR-02,
   TC-TR-03, TC-TR-04, TC-DUP-02, TC-DUP-03）を満たすテストがすべて成功する。
- dry-run の既存挙動（高速・副作用最小）が維持される。
- 仕様変更なし（invalid regex は例外送出のまま）。
- 振替ルールは、同じ `mappingRules` 配列内でカテゴリルールと共存できる。
- 仕様変更: 個々のルールで `isTransfer=true` と `category` を同時に指定した
   場合はエラーになります（設定ミスの早期検出のため）。ただし、振替ルールと
   カテゴリルールは同一の `mappingRules` 配列内で別々のルールとして共存
   できます。
