# ai-pr-review-action

OpenAI を使って Pull Request を自動レビューし、PR にサマリーコメントと行コメントを投稿する GitHub Action です。

## Features

- モデルを入力で切り替え可能（例: `gpt-5-mini`, `gpt-5`, `gpt-5.2`）
- `.ai-review.yml` によるレビュー方針のカスタマイズ
- 実行ごとに `custom_instructions` を追記可能
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
        uses: syunpeii/ai-pr-review-action@v1
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-5
```

### パターン2: `/ai-review` コメントで手動トリガー

PRコメントで実行したい場合は `issue_comment` イベントを使います。PR限定のコメントであれば `issue.number` がそのままPR番号になるため、`pr_number` の明示指定は不要です。

コメント構文:

| コメント例 | 動作 |
|---|---|
| `/ai-review` | デフォルトモデルで実行 |
| `/ai-review gpt-5.2` | 指定モデルで実行 |
| `/ai-review gpt-5 セキュリティを重点に` | 指定モデル＋追加指示 |

> モデルを省略した場合は `.ai-review.yml` の `default_model` → Action の `model` input → `gpt-5-mini` の順でフォールバックします。

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
      startsWith(github.event.comment.body, '/ai-review')
    steps:
      - name: Parse comment
        id: parse
        env:
          COMMENT: ${{ github.event.comment.body }}
        run: |
          python - <<'PY'
          import os, re

          comment = os.environ["COMMENT"].strip()
          # /ai-review の後の部分を取得
          rest = re.sub(r'^/ai-review\s*', '', comment).strip()

          # 先頭トークンがモデル名かどうか判定（英数字・ハイフン・ドットのみ）
          model = ""
          instructions = rest
          m = re.match(r'^([\w.\-]+)\s*(.*)', rest, re.DOTALL)
          if m and re.match(r'^[a-zA-Z0-9][\w.\-]*$', m.group(1)):
              model = m.group(1)
              instructions = m.group(2).strip()

          with open(os.environ["GITHUB_OUTPUT"], "a") as f:
              f.write(f"model={model}\n")
              f.write("instructions<<EOF\n")
              f.write(instructions + "\n" if instructions else "\n")
              f.write("EOF\n")
          PY

      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run AI PR review
        uses: syunpeii/ai-pr-review-action@v1
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          model: ${{ steps.parse.outputs.model }}
          custom_instructions: ${{ steps.parse.outputs.instructions }}
```

> **注意:** `issue_comment` トリガーはデフォルトブランチのコードで実行されるため、未信頼PRコードを実行しない安全な設計です。

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `openai_api_key` | yes | - | OpenAI API key |
| `github_token` | no | `github.token` | GitHub API 呼び出し用トークン |
| `model` | no | `.ai-review.yml` の `default_model` → `gpt-5-mini` | 使用する OpenAI モデル。空文字の場合は設定ファイルのデフォルトを使用 |
| `max_output_tokens` | no | `1500` | OpenAI 応答の最大トークン |
| `pr_number` | no | auto-detect | レビュー対象PR番号 |
| `config_path` | no | `.ai-review.yml` | レビュー設定ファイルのパス |
| `custom_instructions` | no | `""` | 実行時に追加するレビュー指示 |

## Configuration file

リポジトリルートに `.ai-review.yml` を置くことでレビュー観点を調整できます。ファイルが存在しない場合はすべてデフォルト値で動作します。

```yaml
reviewer_role: "シニアAndroidエンジニア"
tech_stack: "Kotlin, Jetpack Compose, Hilt, Room, CI/CD"
review_focus: "バグ、例外系、リグレッション、可読性"
additional_rules: |
  推測ベースの指摘は避け、コード上で確定できる事実のみを指摘すること。
file_priorities:
  kt: 10
  gradle: 9
  yml: 8
  md: 5
exclude_patterns:
  - "**/generated/**"
comment_language: "ja"
```

### Fields

| フィールド | デフォルト | 説明 |
|---|---|---|
| `reviewer_role` | `""` | AI のペルソナ設定。システムプロンプトの「あなたは〇〇です」に埋め込まれます。例: `"シニアiOSエンジニア"` |
| `tech_stack` | `""` | プロジェクトの技術スタック。レビュー観点のひとつとして AI に渡されます。例: `"Kotlin, Compose, Hilt"` |
| `review_focus` | `""` | 重点レビュー観点。例: `"バグ、例外ハンドリング、パフォーマンス"` |
| `additional_rules` | `""` | AI への追加ルール。「絶対にコメントしてはいけない例」など、挙動の細かい調整に使います。複数行記述可。 |
| `default_model` | `""` | デフォルトで使用するモデル名。Action input の `model` が空のときに参照されます。例: `"gpt-5"` |
| `file_priorities` | `kt:10, gradle:9, xml:8, json:7, yml:6, md:5` | 拡張子ごとのレビュー優先度（1〜10）。PRが大きくトークン上限に近い場合、優先度の高いファイルから処理されます。 |
| `exclude_patterns` | `[]` | レビュー対象から除外するファイルのglobパターン。例: `"**/generated/**"`, `"**/build/**"` |
| `comment_language` | `"ja"` | レビューコメントの言語コード。`"ja"` または `"en"` など。 |

### `additional_rules` と `custom_instructions` の関係

`additional_rules`（`.ai-review.yml`）と Action input の `custom_instructions` は **両方指定した場合に結合**されます。

```
additionalRules = additional_rules + "\n\n" + custom_instructions
```

リポジトリ共通の方針は `additional_rules` に書き、実行ごとに変えたい指示は `custom_instructions` で渡すと管理しやすいです。

### 設定ファイルのパスを変更する

`config_path` input で任意のパスを指定できます。

```yaml
- uses: syunpeii/ai-pr-review-action@v1
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    config_path: .github/ai-review.yml
```

## Security notes

- `issue_comment` で動かす場合は、未信頼PRコード実行のリスクを避けるため workflow 設計に注意してください。
- 最小権限で実行してください（`pull-requests: write`, `contents: read`）。
