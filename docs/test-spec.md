# テスト仕様書

## 1. 目的

- PayPay CSV 取り込み処理の回帰を防ぎ、境界条件と失敗系の挙動を安定して保証する。
- とくに不正な正規表現、空の keyword、BOM 付き CSV、振替ルール、重複履歴の flush 失敗の仕様を明文化する。
- 日付入力後の datepicker 残留による保存失敗を防ぐ UI 安定化挙動を明文化する。

## 2. 範囲

- 対象レイヤー: unit test / integration test / smoke test
- 主対象モジュールは次の 3 つ。
  - src/import-core.js
  - src/duplicate-detector.js
  - src/import-paypay-to-mfme.js（smoke のエントリーポイント確認）

## 3. テスト観点

| 観点ID | 観点 | 対象関数 | 期待挙動 |
| ---- | ---- | ---- | ---- |
| TC-REGEX-01 | regex 正常系 | isRuleMatch | 有効な regex で true/false を判定 |
| TC-REGEX-02 | regex 不正系 | isRuleMatch / applyMapping | 不正な regex は例外を送出（現状仕様） |
| TC-KW-01 | 空の keyword | isRuleMatch | 空文字/null/undefined は false |
| TC-CSV-01 | BOM 付き CSV | loadCsv | BOM を除去して正常に 2 件読み込む |
| TC-TR-01 | 振替ルール正規化 | normalizeConfig | isTransfer と transferAccount を正規化 |
| TC-TR-02 | 振替ルール適用 | applyMapping | category を使わず振替情報を付与 |
| TC-TR-03 | 振替口座解決 | resolveTransferAccounts | 入出金方向に応じて振替元・振替先を決定 |
| TC-TR-04 | 競合時の優先順位 | applyMapping | priority優先、同値は設定順で決定 |
| TC-UI-01 | 保存前 datepicker クローズ | closeDatepickerBeforeSubmit | 日付入力後に datepicker のクローズを試み、後続の保存操作を阻害しない |
| TC-UI-02 | close ステップ診断情報 | closeDatepickerBeforeSubmit | 失敗ステップの ok/error を結果オブジェクトに格納し、関数自体は例外送出しない |
| TC-DUP-01 | flush 正常系 | LocalDuplicateDetector.flush | processed.json の保存に成功する |
| TC-DUP-02 | flush 失敗系 | LocalDuplicateDetector.flush | DuplicateHistorySaveError を送出する |
| TC-DUP-03 | flush 失敗後再試行性 | LocalDuplicateDetector.flush | dirty=true を維持する |

## 4. ケース一覧

### 4.1 import-core

| ケースID | テスト名（node:test） | 前提 | 入力 | 期待結果 |
| ---- | ---- | ---- | ---- | ---- |
| TC-REGEX-02A | isRuleMatch throws when regex pattern is invalid | merchant が存在する | matchMode=regex, keyword="([invalid" | 例外を送出する |
| TC-REGEX-02B | applyMapping propagates regex syntax errors | 対象 transaction が 1 件 | mappingRules に不正な regex を含む | 例外を送出する |
| TC-KW-01A | isRuleMatch rejects empty keyword values | merchant が存在する | keyword=""/null/undefined | すべて false |
| TC-CSV-01A | loadCsv reads BOM-prefixed CSV fixture file | samples/paypay_sample_bom.csv が存在する | loadCsv(fixturePath) | parseFailures=0, transactions=2 |
| TC-TR-01A | normalizeConfig normalizes transfer rules in mappingRules | transfer rule を含む設定 | isTransfer=true, transferAccount あり | 正規化後も値を保持する |
| TC-TR-01B | normalizeMappingRule throws when isTransfer and category are both specified | ルールに両方指定 | isTransfer=true, categoryあり | 例外が投げられる |
| TC-TR-01C | normalizeMappingRule trims and lowercases isTransfer strings | ルールに `isTransfer` が文字列で設定されている | `isTransfer: ' FALSE '` | `isTransfer` は `trim()` + 小文字化で判定され、false と扱われる |
| TC-TR-01D | normalizeMappingRule trims whitespace from category | ルールに前後空白付きの `category` が設定されている | `category: ' 食費 '` | `category` は `trim()` が適用され `'食費'` になる |
| TC-TR-02A | applyMapping marks transfer rules and leaves category uncategorized | 対象 transaction が 1 件 | isTransfer=true のルール | isTransfer=true, category=Uncategorized |
| TC-TR-02B | applyMapping throws when matched transfer rule is missing transferAccount | 対象 transaction が 1 件 | transferAccount なしの振替ルール | 例外を送出する |
| TC-TR-03A | resolveTransferAccounts maps expense and income around PayPay account | mfAccount=PayPay | expense/income の振替 transaction | 振替元・振替先が期待どおり |
| TC-TR-03B | resolveTransferAccounts rejects same-account transfers | mfAccount と transferAccount が同一 | 振替 transaction | 例外を送出する |
| TC-TR-04A | applyMapping prioritizes higher-priority transfer rule over category rule | 同一 keyword で複数ルール | transfer と category で priority 差あり | 高 priority のルールを採用 |
| TC-TR-04B | applyMapping uses declaration order when priorities are equal | 同一 keyword で複数ルール | transfer と category で priority 同値 | mappingRules の上側ルールを採用 |

### 4.2 duplicate-detector

| ケースID | テスト名（node:test） | 前提 | 入力 | 期待結果 |
| ---- | ---- | ---- | ---- | ---- |
| TC-DUP-02A | local detector flush throws DuplicateHistorySaveError when rename fails | markProcessed 済み | fs.renameSync を失敗モック | DuplicateHistorySaveError を送出する |
| TC-DUP-03A | local detector keeps dirty state after flush failure for retry | markProcessed 済み | flush 失敗後の dirty を参照 | dirty=true を維持する |

### 4.3 import-paypay-to-mfme

| ケースID | テスト名（確認観点） | 前提 | 入力 | 期待結果 |
| ---- | ---- | ---- | ---- | ---- |
| TC-UI-01A | datepicker is explicitly closed before submit click | Money Forward の手入力モーダル表示中 | 日付入力後に保存処理を実行 | 保存前に datepicker クローズを試み、保存クリックへ進む |
| TC-UI-02A | closeDatepickerBeforeSubmit swallows close step errors and keeps going | close 3 ステップが失敗するモック | press/evaluate/wait すべて失敗 | 関数は例外を送出せず、返却値で各ステップの失敗を検証できる |
| TC-UI-02B | closeDatepickerBeforeSubmit returns diagnostics when some close steps fail | press と wait のみ失敗するモック | press/wait 失敗 | `ok=false` かつ失敗ステップの `error` が保持される |

## 5. テストデータ

- 固定 fixture:
- samples/paypay_sample.csv
- samples/paypay_sample_bom.csv（UTF-8 BOM 付き）
- 一時ファイル:
- test/import-core.test.js 内で作成する sample.csv

## 6. 実行手順

1. 依存関係をクリーンインストールする: npm ci
2. Markdown を lint する: npm run lint:md
3. ユニット/統合テストを実行する: npm test
4. smoke を実行する: npm run smoke:dry-run

## 7. 受け入れ基準

- 追加した観点（TC-REGEX-02, TC-KW-01, TC-CSV-01, TC-TR-01, TC-TR-02,
   TC-TR-03, TC-TR-04, TC-UI-01, TC-UI-02, TC-DUP-02, TC-DUP-03）を満たすテストがすべて成功する。
- dry-run の既存挙動（高速で、副作用を最小限に抑える）が維持される。
- 仕様変更なし（不正な regex は例外送出のまま）。
- 振替ルールは、同じ `mappingRules` 配列内でカテゴリルールと共存できる。
- 仕様変更: 個々のルールで `isTransfer=true` と `category` を同時に指定した
   場合はエラーになる（設定ミスを早期に検出するため）。ただし、振替ルールと
   カテゴリルールは同一の `mappingRules` 配列内で別々のルールとして共存
   できる。
