# 勤怠ボット

Slackのコマンドで勤務・休憩を記録し、実働時間と給与を集計する、本人専用のBotです。終了した勤務はGoogle Sheetsにも転記します。

## 使い方

| コマンド | 操作 |
| --- | --- |
| `/start` | 勤務を開始 |
| `/bi` | 休憩を開始 |
| `/bo` | 休憩を終了して勤務を再開 |
| `/end` | 勤務を終了し、実働を保存 |
| `/week` | 今週の終了済み勤務を集計（月曜始まり） |
| `/month` | 今月の終了済み勤務と給与を集計 |

毎月1日9:00（日本時間）には、前月の給与を指定チャンネルに投稿します。

## 仕組み

```text
Slack → Cloudflare Workers / Durable Object → Google Apps Script → Google Sheets
```

## セットアップ

1. 依存パッケージと設定ファイルを準備します。

   ```bash
   npm ci
   cp .env.example .env
   ```

2. **Slack**：`slack-manifest.json` からアプリを作成し、各コマンドのURLを `https://<WorkerのURL>/slack/commands` に設定します。アプリをインストールし、投稿先チャンネルに追加します。必要な権限は `commands` と `chat:write` です。
3. **Google Apps Script**：`gas/Code.gs`、`gas/Payroll.gs`、`gas/appsscript.json` をプロジェクトに反映します。スクリプトプロパティに `GAS_SHARED_SECRET` と `HOURLY_RATE` を設定し、`setup()` を実行します。既存のスプレッドシートを使う場合は、先に `SPREADSHEET_ID` を設定してください。その後、本人権限で実行するウェブアプリとして公開します。
4. **設定**：`.env` に以下の値を設定します。深夜設定を変える場合は、Apps Scriptのスクリプトプロパティにも同じ値を設定してください。
5. **デプロイ**：`npx wrangler whoami` で対象アカウントを確認し、`npm run deploy` を実行します。Slackに設定したコマンドURLが実際のWorkerのURLと一致することを確認してください。

### 環境変数

| 変数 | 内容 |
| --- | --- |
| `SLACK_SIGNING_SECRET` | SlackアプリのSigning Secret |
| `SLACK_BOT_TOKEN` | SlackアプリのBotトークン |
| `ALLOWED_TEAM_ID` | 利用を許可するワークスペースのID |
| `ALLOWED_USER_ID` | 利用を許可する本人のユーザーID |
| `POST_CHANNEL_ID` | 勤務・給与を投稿するチャンネルのID |
| `MENTION_USER_ID` | 勤務開始・給与投稿時にメンションするユーザーのID |
| `HOURLY_RATE` | 通常時給（円） |
| `NIGHT_START_HOUR` | 深夜帯の開始時刻（0〜23、既定 `22`） |
| `NIGHT_END_HOUR` | 深夜帯の終了時刻（0〜23、既定 `5`） |
| `NIGHT_MULTIPLIER` | 深夜時給の倍率（既定 `1.25`） |
| `GAS_URL` | Apps Scriptウェブアプリの `/exec` URL |
| `GAS_SHARED_SECRET` | Apps Scriptと共有する署名用の鍵 |

## 開発・デプロイ

```bash
npm test          # テスト
npm run check     # デプロイのドライラン
npm run dev       # ローカル開発
npm run deploy    # .envの設定とともにデプロイ
```
