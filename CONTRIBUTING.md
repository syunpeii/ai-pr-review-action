# Contributing

このリポジトリへの変更は、Pull Requestで行ってください。

## 開発環境

- Node.js 20
- npm

依存関係をインストールします。

```sh
npm ci
```

## 変更とビルド生成物

ActionはTypeScriptのソース（`src/`）に加えて、コンパイル済みの`dist/`と配布用の`bundle/`をリポジトリに含めています。ソースを変更した場合は、次を実行して生成物を更新し、ソースと一緒にコミットしてください。

```sh
npm run build
```

CIではビルドとユニットテストの後に`dist/`と`bundle/`の差分を確認します。生成物が古い場合、このチェックが失敗します。

## 変更前の確認

Pull Requestを作成する前に、次を実行してください。

```sh
npm test
git diff --exit-code dist/ bundle/
```

`npm test`はTypeScriptのビルド、配布bundleの生成、ユニットテストを実行します。生成物に意図した差分がある場合、2つ目のコマンドは失敗するので、`dist/`と`bundle/`をコミットに含めてください。`npm test`の後にソースを変更した場合は、再度`npm test`を実行してください。

## 実際のPRを使ったレビュー動作確認

通常のCIではユニットテストを実行します。実際のPRにレビューを投稿するE2E確認は、同一リポジトリ内のPRに`verify-ai-review`または`verify-ai-review-single`ラベルを付けるか、Actionsからworkflowを手動実行した場合に行われます。実行には`OPENAI_API_KEY`シークレットが必要です。手動実行では対象PR番号、レビュー方式、モデルを指定できます。

この確認は実際のPRへコメントを投稿するため、必要な変更を含む検証用PRでのみ実行してください。
