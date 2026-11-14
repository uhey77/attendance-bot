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

開始・休憩・再開・終了は指定チャンネルに投稿されます。開始時に指定ユーザーをメンションし、以降は同じスレッドに返信します。集計結果は本人にのみ表示されます。

既存環境でコマンドを変更する場合は、Workerをデプロイした後、Slackアプリのスラッシュコマンド設定で `/break` を `/bi`、`/resume` を `/bo` に変更してください。移行中もWorkerは従来のコマンドを受け付けます。

毎月1日9:00（日本時間）には、前月の給与を指定チャンネルに投稿します。

### 集計ルール

- 勤務時間は日本時間の**開始日**に計上します。日をまたぐ勤務も開始日の集計に含まれます。
- 勤務時間から休憩を除き、終了済みの勤務のみを集計します。
- 22:00〜翌5:00の実働は、通常時給の1.25倍で計算します（時刻・倍率は変更可能）。開始・終了時刻が不明な手動記録は通常時給で計算します。
- 給与は通常分と深夜分を合算し、月合計で1円未満を四捨五入します。

## 仕組み

```text
Slack → Cloudflare Workers / Durable Object → Google Apps Script → Google Sheets
```

勤務記録の正本はCloudflareに保存され、Sheetsへ非同期で転記されます。転記に失敗した場合は再試行します。Sheetsを直接編集してもSlackの集計には反映されません。

## セットアップ

Node.js 22以降、Cloudflare、Slack、Google Apps Scriptの環境が必要です。

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

`.env` はGit管理外です。ローカル開発時に読み込まれ、手動デプロイ時にはCloudflareのシークレットとしてアップロードされます。

## 開発・デプロイ

```bash
npm test          # テスト
npm run check     # デプロイのドライラン
npm run dev       # ローカル開発
npm run deploy    # .envの設定とともにデプロイ
```

`main` へのpush時は、GitHub Actionsがテスト成功後にWorkerを自動デプロイします。リポジトリに `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` のシークレットが必要です。自動デプロイはCloudflareに登録済みの設定を引き継ぎ、Apps Scriptは更新しません。

## 運用上の注意

- 外部サービスに障害があっても、終了した勤務はCloudflareに保存されます。Sheetsへの反映待ちは `/week`・`/month` に表示されます。
- Slackへの投稿結果が不明な場合は重複投稿を避けるため送信を停止します。実際のスレッドを確認してから投稿待ちを復旧してください。
- Durable Objectの保存状態を削除すると勤務記録が失われます。
- 既存環境へ深夜料金に対応した版を初めて反映する場合は、Apps Scriptの更新後に `setupPayroll()` を実行してウェブアプリを再デプロイし、その後Workerを更新してください。次のコマンドまたは月初の集計時に保存済み勤務がSheetsへの転記待ちに追加されます。反映後に `/month` とSheetsを照合してください。
- 深夜帯や倍率を変更した場合は、WorkerとApps Scriptの両方に設定し、`setupPayroll()` を再実行してSheetsの深夜時間を再計算してください。
