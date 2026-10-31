# AI PR Review Action E2E 検証用フィクスチャ

このディレクトリは、リリース前（ブランチ・コミット単位）に GitHub Actions 上で実際の OpenAI API を呼び出し、レビュー生成・行コメント投稿・`review_mode: verified`・`AI_REVIEW_INSTRUCTIONS` ブロックの動作を一貫して検証するためのベンチマークセットです。

> [!NOTE]
> `README.md` と `apply-verify-diff.mjs` は `.ai-review.yml` の `exclude_patterns` で除外されているため、AIレビューには `order-service.ts` の差分のみが渡されます。

---

## 検証手順

### 1. 検証用ブランチの作成と差分の生成

改修ブランチ（例: `release/v2`）から検証用ブランチを作成し、`npm run verify:prepare` を実行してコミットします。

```bash
git checkout release/v2
git checkout -b verify/v2-sample
npm run verify:prepare
git commit -am "test: verify AI review on sample order service"
git push -u origin verify/v2-sample
```

### 2. GitHub 上で PR を作成

- **base branch**: `release/v2`（または検証対象の改修ブランチ）
- **compare branch**: `verify/v2-sample`
- Draft PR で作成して構いません（検証完了後はマージせず Close します）。
- PR 本文に以下のテンプレートを貼り付けると、`AI_REVIEW_INSTRUCTIONS` の抽出と状態表示も同時に検証できます。

````markdown
クーポン割引計算と平均単価の算出を追加しました。

<!-- AI_REVIEW_INSTRUCTIONS_START
- 割引適用後の金額に対して消費税を再計算しない仕様（割引前課税対象額ベース）は今回の要件通りです。
- 非同期処理の待機漏れや境界値バグ（0件時・負数数量など）、ループ内の計算量悪化を重点的に確認してください。
AI_REVIEW_INSTRUCTIONS_END -->
````

### 3. レビューの実行

PR に以下のいずれかのラベルを付与すると、`.github/workflows/ci.yml` の `verify-action` ジョブが実行されます（Write 権限保持者のみ実行可能・Fork PR では実行されません）：

- `verify-ai-review` ラベル: **`review_mode: verified`** で実行
- `verify-ai-review-single` ラベル: **`review_mode: single`** で実行

（`main` ブランチにワークフローが反映された後は、GitHub の **Actions タブ > CI & Self Review Verification > Run workflow** から PR 番号を指定して手動実行することも可能です）

---

## 仕込まれている差分と期待されるレビュー結果（正解表）

`npm run verify:prepare` によって `order-service.ts` に適用される変更には、以下のポイントが含まれています。

| 区分 | 箇所 | 内容 | 期待されるAIの挙動 |
| :--- | :--- | :--- | :--- |
| 🔴 **Critical** | `finalizeOrder` 内の `auditLogger.record(...)` | `await` が削除されており、監査ログ記録の失敗や未完了を検知できない | **行コメントで指摘されるべき** |
| 🔴 **Critical** | `calculateOrderSummary` の `line.quantity <= 0` チェック削除 & `order.lines.length` 除算 | 数量 `0` や負数のバリデーションが消えている／`order.lines` が空配列のときに `0` 除算（`NaN`）になる | **行コメントで指摘されるべき** |
| ⚡ **Performance** | `calculateOrderSummary` のループ内 | `Map` ルックアップから毎回の `catalog.find(...)` / `catalog.filter(...)` に変更されており、明細数×カタログ数の $O(N \times M)$ になっている | **Performance として指摘されるべき** |
| 🎯 **仕様通り（抑制対象）** | `Math.floor(lineAmount * order.coupon.discountRate)` / 割引前課税 | `.ai-review.yml` の `project_context`（端数切り捨て仕様）および PR 本文の `AI_REVIEW_INSTRUCTIONS`（割引前課税仕様）で明記済み | **不要な指摘が抑制されるべき（特に `verified` モード）** |
