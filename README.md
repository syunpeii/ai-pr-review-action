# ai-pr-review-action

OpenAI を使って Pull Request を自動レビューし、PR にサマリーコメントと行コメントを投稿する GitHub Action です。

## Features

- モデルを入力で切り替え可能（例: `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.1-sol`）
- `.ai-review.yml` によるレビュー方針のカスタマイズ
- 案件固有情報（`project_context`）と、PR 本文の HTML コメントによる今回だけの追加指示に対応
- PR diff とファイル内容を解析し、summary + line comments を投稿

## Quick start

このActionはトリガーを持ちません。呼び出し側のワークフローで自由にトリガーを選べます。
利用する各プロジェクト側で、`.github/workflows/ai-review.yml` のような workflow ファイルを新規作成して配置してください。

### パターン1: PR作成・更新時に自動実行

```yaml
name: AI PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write
  contents: read

jobs:
  ai-review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run AI PR review
        uses: syunpeii/ai-pr-review-action@v2
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-6.1-sol
```

### パターン2: `/ai-review` コメントで手動トリガー

PRコメントで実行したい場合は `issue_comment` イベントを使います。PR限定のコメントであれば `issue.number` がそのままPR番号になるため、`pr_number` の明示指定は不要です。

コメント構文:

| コメント例 | 動作 |
|---|---|
| `/ai-review` | デフォルトモデルで実行 |
| `/ai-review gpt-6.1-sol` | 指定モデルで実行 |

> 今回だけの追加指示は、コメントではなく PR 本文の `AI_REVIEW_INSTRUCTIONS` ブロックに記載してください（後述）。
>
> モデルを省略した場合は `.ai-review.yml` の `default_model` → Action の `model` input → `gpt-6-luna` の順でフォールバックします。

このコメント解析はワークフロー側で行います。以下はその実装例です。

```yaml
name: AI PR Review

on:
  issue_comment:
    types: [created]

permissions:
  pull-requests: write
  contents: read

jobs:
  ai-review:
    runs-on: ubuntu-latest
    if: |
      github.event.issue.pull_request &&
      startsWith(github.event.comment.body, '/ai-review') &&
      contains(fromJSON('["MEMBER", "OWNER", "COLLABORATOR"]'), github.event.comment.author_association)
    steps:
      - name: Parse comment
        id: parse
        env:
          COMMENT: ${{ github.event.comment.body }}
        run: |
          python - <<'PY'
          import os, re

          comment = os.environ["COMMENT"].strip()
          # /ai-review の後の先頭トークンがモデル名（英数字・ハイフン・ドットのみ）なら取得
          rest = re.sub(r'^/ai-review\s*', '', comment).strip()
          m = re.match(r'^([a-zA-Z0-9][\w.\-]*)', rest)
          model = m.group(1) if m else ""

          with open(os.environ["GITHUB_OUTPUT"], "a") as f:
              f.write(f"model={model}\n")
          PY

      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run AI PR review
        uses: syunpeii/ai-pr-review-action@v2
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          model: ${{ steps.parse.outputs.model }}
```

> **注意:** `issue_comment` トリガーはデフォルトブランチのコードで実行されるため、未信頼PRコードを実行しない安全な設計です。
> 実行者は `MEMBER`、`OWNER`、`COLLABORATOR` に限定してください。Action 側でも同じ制限を検証するため、外部ユーザーによる API 利用料の消費を防げます。

## v1 からの移行（v2 の破壊的変更）

- `.ai-review.yml` の `reviewer_role` / `tech_stack` / `review_focus` / `additional_rules` は**削除**されました。残っていると、移行先を示すエラーで停止します。共通情報は `project_context` に、今回だけの指示は PR 本文の `AI_REVIEW_INSTRUCTIONS` ブロックに記載してください。固定プロンプトの「あなたは〇〇です」への役割埋め込みもなくなりました。
- Action input の `custom_instructions` は**削除**されました。`/ai-review` コメント起動で追加指示を渡していた場合は、PR 本文のブロックへ移してください。
- 長い PR 本文は丸ごと除外されず、`max_pr_body_chars` まで送信されるようになりました。
- 概要に、レビュー方式と使用した追加情報の状態が表示されます。
- `max_input_tokens` が小さすぎる場合は、レビュー未実施と表示して正常終了します。
- 新機能: `review_mode: verified`（検証付きレビュー）、`project_context`、`max_pr_body_chars`。

`v1` タグは更新されません。従来の挙動のまま使う場合は `@v1` を参照し続けてください。

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `openai_api_key` | yes | - | OpenAI API key |
| `github_token` | no | `github.token` | GitHub API 呼び出し用トークン |
| `model` | no | `.ai-review.yml` の `default_model` → `gpt-6-luna` | 使用する OpenAI モデル。空文字の場合は設定ファイルのデフォルトを使用 |
| `max_output_tokens` | no | unset | OpenAI Responses API の最大出力トークン。未指定時は Action 側で出力を制限しない。 |
| `max_input_tokens` | no | unset | OpenAI に送る入力の概算最大トークン。未指定時は Action 側で PR 情報を切り詰めない。指定時は `file_priorities` 順に収める。 |
| `max_pr_body_chars` | no | `10000` | 通常 PR 本文（追加指示ブロックを除く）の最大文字数。超過分だけ段落・行の境界で省略します。 |
| `review_mode` | no | `single` | `single`: 1回のレビュー。`verified`: 下書きの指摘候補を元のコードと照合して採用・修正・却下し、確定結果のみ投稿する（API を2回呼ぶため、時間とトークンが増える）。 |
| `pr_number` | no | auto-detect | レビュー対象PR番号 |
| `config_path` | no | `.ai-review.yml` | レビュー設定ファイルのパス |

## 検証付きレビュー (`review_mode: verified`)

1回目で下書きを生成し、2回目で同じコンテキストと指摘候補を照合します。投稿されるのは検証後の概要と指摘のみで、下書きや検証の内部理由は投稿されません。

- 検証が失敗した場合（API エラー、不正・途切れた応答、候補が入力上限に収まらない等）は、未検証の指摘を投稿せず、「検証未完了」の警告概要のみを投稿します（ワークフローは失敗しません）。
- `max_input_tokens` 指定時、`verified` では1回目のコード入力を上限の80%程度に絞り、候補の領域を確保します。
- 両段階で `model` を使用し、投稿されるトークン使用量は両段階の合計です。
- AI による検証は正しさを保証するものではありません。同じモデルが同じ誤りを繰り返す可能性があります。

## Configuration file

### トークン上限の設定

`max_input_tokens` と `max_output_tokens` は Action の input として個別に設定できます。どちらも未指定の場合、Action 側では入力・出力を切り詰めません（利用するモデルと OpenAI Responses API の制限は適用されます）。

```yaml
- uses: syunpeii/ai-pr-review-action@v2
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    max_input_tokens: 20000
    max_output_tokens: 2000
```

開始時の目安は、通常の PR では `max_input_tokens: 20000`、`max_output_tokens: 2000` です。大規模な PR や詳細なレビューが必要な場合は増やしてください。入力上限を指定した場合、上限を超える PR は `.ai-review.yml` の `file_priorities` が高いファイルから優先して送信されます。

リポジトリルートに `.ai-review.yml` を置くことでレビュー観点を調整できます。ファイルが存在しない場合はすべてデフォルト値で動作します。

```yaml
project_context: |
  このサービスの日時は UTC で保存します。
  API レスポンスの形式は既存クライアントとの互換性を維持してください。
file_priorities:
  kt: 10
  gradle: 9
  yml: 8
  md: 5
exclude_patterns:
  - "**/generated/**"
# 既定ではPRメタデータを送信。必要に応じて個別に除外できます。
include_pr_title: true
include_pr_body: true
include_pr_labels: true
comment_language: "ja"
```

### Fields

| フィールド | デフォルト | 説明 |
|---|---|---|
| `project_context` | `""` | 案件固有情報（業務仕様、設計上の制約、採用技術、意図的な実装方針）。最大30,000文字。背景情報としてレビューに渡され、出力形式を変更する指示としては扱われません。 |
| `default_model` | `""` | デフォルトで使用するモデル名。Action input の `model` が空のときに参照されます。例: `"gpt-6.1-sol"` |
| `file_priorities` | `kt:10, gradle:9, xml:8, json:7, yml:6, md:5` | 拡張子ごとのレビュー優先度（1〜10）。PRが大きくトークン上限に近い場合、優先度の高いファイルから処理されます。 |
| `exclude_patterns` | `[]` | レビュー対象から除外するファイルのglobパターン。例: `"**/generated/**"`, `"**/build/**"` |
| `include_pr_title` | `true` | `false` にすると PR タイトルを OpenAI API に送信しない。 |
| `include_pr_body` | `true` | `false` にすると PR 本文を OpenAI API に送信しない。 |
| `include_pr_labels` | `true` | `false` にすると PR ラベルを OpenAI API に送信しない。 |
| `comment_language` | `"ja"` | レビューコメントの言語コード。`"ja"` または `"en"` など。 |

PR レビューでは、PR タイトル・本文・ラベル・対象ファイルの差分、ならびに条件に応じたファイル全文を OpenAI API に送信します。PR メタデータは上記の `include_pr_*` 設定で個別に除外でき、ファイルは `exclude_patterns` で除外できます。既定ではすべて送信されます。

設定ファイルは厳格に検証されます。未知のフィールド、型の不一致、不正な値がある場合は Action を停止します。`file_priorities` の値は `1`〜`10` の整数（最大100件）、`exclude_patterns` は最大100件・各500文字までです。テキスト項目にも長さの上限があります。`comment_language` は `ja`、`en`、`en-US` などの言語タグ形式を受け付け、特定の言語には限定しません。

### PR 本文からの追加指示

今回の PR だけの重点確認事項は、PR 本文に専用の HTML コメントで記載します。PR の通常表示には出ませんが、Action は本文として取得します（自動実行・コメント起動のどちらでも同じ）。

```markdown
## 概要
認証トークンの更新処理を変更しました。

<!-- AI_REVIEW_INSTRUCTIONS_START
認証トークン更新の同時実行時に競合が発生しないか確認してください。
AI_REVIEW_INSTRUCTIONS_END -->
```

- マーカーは完全一致・大文字です。改行は LF / CRLF の両方に対応します。
- 抽出は本文の省略より先に、元の本文全体に対して行います。抽出したブロックは通常本文から除かれます。
- 複数ブロックは記載順に結合され、空のブロックは「指定なし」です。終了マーカー欠落などの不正なブロックは警告し、内容は通常本文としてのみ扱います（概要に表示されます）。
- `include_pr_body: false` の場合、追加指示も送信されません（概要に「設定により除外」と表示）。
- 追加指示は PR 作成者が書ける内容です。信頼できない PR（fork など）では、指示による誘導の可能性があることに注意してください。

### 入力の優先順位と省略

案件固有情報と追加指示は通常本文より優先されます。通常本文は `max_pr_body_chars` まで含め、超過分だけを省略します（長い本文を丸ごと除外することはありません）。`max_input_tokens`（概算）指定時は、通常本文 → ラベル等のメタデータ → ファイル全文 → 差分の順に削減し、それでも収まらない場合に限り案件情報と追加指示を文字数比で省略します。コード用の領域（入力予算の約半分）は確保されます。省略はログと概要に表示され、ワークフローは失敗しません。`max_input_tokens` が小さすぎて最小限の入力も収まらない場合は、API を呼ばず「レビュー未実施」と概要に表示して正常終了します。

概要には、実際にモデルへの入力に含めた追加情報（案件固有情報、PR 本文の指示）の状態が表示されます。「反映済み」は入力に含めたという意味で、モデルが指示に従ったことを保証しません。

### 設定ファイルのパスを変更する

`config_path` input で任意のパスを指定できます。

```yaml
- uses: syunpeii/ai-pr-review-action@v2
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    config_path: .github/ai-review.yml
```

## Security notes

- `issue_comment` で動かす場合は、未信頼PRコード実行のリスクを避けるため workflow 設計に注意してください。
- 最小権限で実行してください（`pull-requests: write`, `contents: read`）。
- 外部 fork からの PR に対して `pull_request_target` を使う場合は、PR の `head.sha` を checkout したり、PR 側のコードをビルド・実行したりしないでください。`pull_request_target` はベースリポジトリの権限とシークレットを利用できるため、未信頼コードの実行はシークレットや書込権限の漏えいにつながります。
- 通常は `pull_request`、または実行者を `MEMBER` / `OWNER` / `COLLABORATOR` に制限した `issue_comment` を使用してください。
- OpenAI API キーは、この Action 専用の Project で発行することを推奨します。Project の Limits で使用可能なモデルを必要なものだけに限定し、コストを確実に抑止したい場合は月次のハード予算上限を設定してください。通知のみの予算アラートでは、上限を超えても API リクエストは継続します。
