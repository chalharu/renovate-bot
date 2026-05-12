# custom-stability-days Worker

このディレクトリには、Renovate 用の独自 stability-days チェックを処理する
Cloudflare Workers 向け TypeScript Worker が入っています。

この Worker は Renovate PR 向けの GitHub `pull_request` webhook
（`pull_request.head.ref` が `renovate/` で始まるもの）を受け取り、
`custom-stability-days` という check run を更新します。対象外のブランチや
未対応アクションは、状態を変えずに `200 OK` で受け流します。

共有 Renovate 設定では、リリース日時を扱える datasource には
`minimumReleaseAge` を使います。一方で Docker Hub 以外の Docker registry
（例: `ghcr.io`）は `minimumReleaseAge: null` にし、
`renovate-wait-3d` ラベルを付けて、この Worker 側で待機期間を判定します。

## 対応している pull_request action

- `opened`
- `reopened`
- `synchronize`
- `labeled`
- `unlabeled`

## 判定フロー

責務は Worker と Renovate 後続 workflow で分離しています。

1. `opened` / `reopened` / `synchronize` で、現在の head SHA に対して
   `queued` の custom check を作成または更新します。
2. Renovate 後続 workflow が open な `renovate/*` PR を走査し、
   Renovate JSON ログ、既存 check state、または PR の `updated_at` から
   `version_created_at` を含む HS256 JWT を生成します。
3. その JWT を custom check の `output.text` に HTML コメントとして埋め込み、
   check を `in_progress` または `completed` に進めます。
4. その後の `labeled` / `unlabeled` では Worker が現在のラベルを取得し、
   埋め込まれた JWT の `version_created_at` を使って pending / success を再計算します。

待機日数は現在のラベルで決まります。

1. `security` があれば即時 success
2. `renovate-wait-<N>d` があれば `N` 日待機
3. どちらもなければ `DEFAULT_WAIT_DAYS`

経過日数の基準は `pull_request.created_at` ではなく
`version_created_at` です。待機期間が終わるまでは check は
`in_progress`、終わったら `completed` + `success` になります。

GitHub が同じ head SHA に対して組み込みの `renovate/stability-days` を
持っている場合は、その結果を優先します。Renovate はこの結果を CheckRun または
commit StatusContext として出すことがあります。組み込み check/status が成功済みなら
custom check も success、まだ完了していなければ custom check も pending のままです。

## release metadata の扱い

JWT は custom check の `output.text` に次の形式で保存します。

```html
<!-- custom-stability-days-jwt:... -->
```

Renovate 後続 workflow は Renovate logging variable の `LOG_CONTEXT` を使って対象リポジトリの
JSON ログを評価し、Renovate 自身が解決した `releaseTimestamp` を最優先で
使います。`releaseTimestamp` が無く `updated_at` / `updatedAt` がログにある場合は、
それを `version_created_at` として使います。ログから metadata を取得できない場合は、
現在の head SHA の check run、または PR の force-push timeline に残る過去 head SHA の
custom check run から、署名済み JWT の `version_created_at` を再利用します。過去 head
SHA から再利用する場合は、同じ `version_created_at` を現 head SHA 用に再署名して保存します。
ログにも check run にも metadata が無い場合だけ、PR の `updated_at` / `updatedAt` から
`version_created_at` を生成して署名済み JWT として custom check に保存します。
どの経路でも `version_created_at` を作れない場合だけ check は queued のままになります。

1 本の Renovate ブランチに複数更新が含まれる場合は、ログ中で最も新しい
`releaseTimestamp` を採用します。これにより、まとめられた更新のうち最も若い
リリースが十分に古くなる前に success へ進んでしまうことを防ぎます。

埋め込まれた JWT がある場合、後続 workflow は Renovate ログと比較します。
`version` と `version_created_at` が同じなら既存 JWT を再利用し、どちらかが変わって
いれば Renovate ログをもとに新しい JWT に置き換えます。ログが無い場合は既存 JWT を
そのまま再利用します。

## 設定

Worker が利用する変数・シークレット:

- `DEFAULT_WAIT_DAYS`: デフォルト待機日数。無効値や未設定時は安全側で `3`
- `GITHUB_APP_CLIENT_ID`: GitHub App JWT の issuer
- `GITHUB_APP_PRIVATE_KEY`: GitHub App の RS256 署名と pending-state JWT の
  HS256 shared secret を兼ねる秘密鍵
- `GITHUB_APP_WEBHOOK_SECRET`: `X-Hub-Signature-256` 検証用シークレット

GitHub App には、対象リポジトリの installation 情報を読める権限、Checks を
更新できる権限、Commit statuses を読める権限が必要です。Renovate 後続 workflow
側にも同じ秘密鍵を `PRIVATE_KEY` として渡し、互換性のある pending-state JWT を
生成できるようにしてください。

## ローカル検証

このディレクトリで次を実行します。

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build` は `wrangler deploy --dry-run --outdir dist` を使い、
Cloudflare Workers へ送られる前のバンドル結果を確認します。

## デプロイ

このリポジトリでは Worker を GitHub Actions からデプロイしません。
TypeScript のビルドと本番デプロイは Cloudflare Workers 側で行う前提です。

`wrangler.toml` では `main = "src/index.ts"` を指定しているため、
Cloudflare Workers は TypeScript の entrypoint から直接ビルドできます。

シークレットは `wrangler.toml` に書かず、Cloudflare Workers 側の設定または
`wrangler secret put` で登録してください。

```sh
wrangler secret put GITHUB_APP_CLIENT_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_APP_WEBHOOK_SECRET
```

デプロイ済み Worker の URL は、GitHub App の `pull_request` webhook エンドポイントに設定します。
