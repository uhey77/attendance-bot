# 勤怠ボット

本人専用のSlack勤怠Botです。Slackのスラッシュコマンドで勤務の開始・休憩・終了を記録し、Google Sheetsへ自動で転記します。

## コマンド

| コマンド | 動作 |
|---|---|
| `/start` | 作業開始 |
| `/break` | 休憩開始 |
| `/resume` | 作業再開 |
| `/end` | 終了して休憩を除いた実働を保存 |
| `/week` | 月曜始まりの今週の終了済み実働 |
| `/month` | 今月の終了済み実働 |

- 集計は日本時間の開始日へ全時間を計上します（23時〜翌1時の勤務は前日の2時間、翌0時30分開始なら翌日の勤務）。
- 休憩・再開では所属日を変えません。
- 作業中・休憩中の未終了勤務は集計に含めません。
- 時間は内部ではミリ秒、Sheetsでは小数の分で保持し、Slack表示時だけ分単位で四捨五入します。

## 構成

```
Slack → Cloudflare Workers（署名・本人確認）→ Durable Object（保存・集計）→ Apps Script（署名・重複確認）→ Google Sheets
```

- Cloudflareを記録の正本とし、Sheetsは自動反映先です。シートを手で編集してもSlackの集計には反映されません。
- 終了時はCloudflareへ保存してから応答し、Sheetsへの転記は別処理で行います。失敗した転記は最大1時間間隔で再試行します。
- 本人以外は記録を変更できず、通常のチャンネルメッセージは読みません。
- コマンドには本人だけが見える応答を返し、開始・休憩・再開・終了は指定チャンネルへBotとして投稿します。
  - 勤務開始で新しい親投稿を作り、指定ユーザーを親投稿だけでメンションします。以後の操作は同じスレッドに返信します。
  - `/week`・`/month` の集計は公開投稿しません。
  - 毎月1日 9:00（日本時間）に、前月分の給与（給与対象実働・時給・合計給与）を指定ユーザーへのメンション付きで独立した投稿として送ります（Cron Trigger）。集計対象は投稿時点で終了済みの勤務です。

## 環境変数

設定値はすべて `.env` にまとめます。`.env.example` をコピーして値を埋めてください（`.env` はGit管理外です）。

```bash
cp .env.example .env
```

| 変数 | 内容 |
|---|---|
| `SLACK_SIGNING_SECRET` | SlackアプリのSigning Secret |
| `SLACK_BOT_TOKEN` | SlackアプリのBotトークン（`xoxb-`） |
| `ALLOWED_TEAM_ID` | 利用を許可するSlackワークスペースのID |
| `ALLOWED_USER_ID` | 記録を許可する本人のユーザーID |
| `POST_CHANNEL_ID` | 開始・休憩・再開・終了を投稿するチャンネルのID |
| `MENTION_USER_ID` | 勤務開始の親投稿でメンションするユーザーのID |
| `HOURLY_RATE` | 給与計算に使う時給（円） |
| `GAS_URL` | Apps Scriptウェブアプリの `/exec` URL |
| `GAS_SHARED_SECRET` | Apps Scriptと共有する署名用の鍵 |

`npm run dev` ではローカルの `.env` が読み込まれます。`npm run deploy` では `.env` の値がCloudflareの暗号化シークレットとして一緒にアップロードされます。

## セットアップ

### Slack

`slack-manifest.json` からアプリを作成します（コマンドのURLは自分のWorkerのURLに置き換えてください）。必要な権限は `commands` と `chat:write` のみで、メッセージの閲覧権限は要求しません。インストール後、Botを投稿先チャンネルに追加します。

### Google Apps Script

1. `gas/Code.gs`・`gas/Payroll.gs`・`gas/appsscript.json` をApps Scriptプロジェクトに反映します。
2. スクリプトプロパティに `GAS_SHARED_SECRET` と `HOURLY_RATE`（時給・円）を設定します。`HOURLY_RATE` は月別給与シートを新しく作るときに使います。
3. `setup()` を実行すると記録用シートを作成し、`SPREADSHEET_ID` を保存します。既存シートを使う場合は先にそのIDを設定してください。
4. ウェブアプリとして本人権限で実行し、Workerから呼べるよう公開します。受信した本文の署名を検証するため、URLを知っているだけでは記録できません。

## 開発

Node.js 22以降が必要です。

```bash
npm ci
```

```bash
npm test
```

```bash
npm run check
```

```bash
npm run dev
```

```bash
npm run deploy
```

デプロイ前に `npx wrangler whoami` で対象アカウントを確認してください。

### 自動デプロイ

PRが `main` にマージされると、GitHub Actions（`.github/workflows/deploy.yml`）がテスト成功後に自動でCloudflare Workersへデプロイします。テスト失敗時はデプロイしません。Actions画面から手動実行も可能です。

- リポジトリのシークレットに `CLOUDFLARE_API_TOKEN`（Workers編集権限のAPIトークン）と `CLOUDFLARE_ACCOUNT_ID` が必要です。
- 自動デプロイでは `.env` を使わず、Cloudflareに登録済みの設定値をそのまま引き継ぎます。設定値を変えるときは、`.env` を更新して手元から `npm run deploy` を実行してください。
- Apps Script（`gas/`）は自動デプロイの対象外で、手動で反映します。

## 運用上の注意

- Slackの再送はリクエストID、Sheetsへの転記は勤務IDで重複排除します。
- 外部障害時にも終了記録はCloudflareに残ります。Sheetsへの反映待ちは週・月集計の応答に表示されます。
- Cloudflareの保存状態やDurable Objectを削除すると勤務記録が失われるため、通常のデプロイでは削除しないでください。
- 履歴が大きくなった場合は、集計の期間別インデックス化が必要です。
- 記録の保存と投稿待ちの保存は同じトランザクションで行い、親投稿のSlack時刻を保存してから返信を送ります。
- 投稿結果がネットワーク切断などで不明になった場合は `uncertain` 状態で止め、重複メンションを避けます。その場合は実際のスレッドを確認して投稿待ちを復旧してください。コマンド応答には投稿待ちがあることを表示します。
