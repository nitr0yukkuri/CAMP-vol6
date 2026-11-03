# Gemini Worker のローカル故障注入・k6確認

この手順は Cloudflare Worker をローカルで起動し、`/api/guide/analyze` からループバック上の偽Gemini APIを呼び出します。Google APIへ通信せず、実際のGemini APIキーも使いません。偽APIは画像本文を保存・ログ出力しません。

Worker側の再試行は、ネットワーク失敗・一時的な `429`・`5xx` に対して最大2回です。日次クォータ超過、認証失敗、不正な成功レスポンスは再試行しません。`Retry-After` が2秒を超える場合もその待ち時間を尊重して即時に再送することはせず、エラーを返します。全体の処理時間にも上限があります。

`GEMINI_TEST_MODE=true` の時だけテスト用URLを受け付けます。URLは設定モデルのGenerateContentパスを持つ `localhost` / `127.0.0.1` / `[::1]` のHTTPに限定し、テストシナリオヘッダーを偽APIへ渡します。Cloudflareの通常設定ではテストモードを有効にしないでください。

## 1. 偽Gemini APIを起動

リポジトリの `C/src/orewosabake` で実行します。

```powershell
node tests/k6/mock-gemini.mjs
```

`127.0.0.1:8789` だけで待ち受け、実際のWorkerリクエスト形状を検証します。成功、一時的・継続的な503、一時的な429、`RESOURCE_EXHAUSTED`、日次クォータ超過、遅い成功、タイムアウト、ネットワーク切断、認証失敗、不正なモデル出力を返します。

## 2. ローカルWorkerを起動

別のPowerShellで同じディレクトリから実行します。状態を実行ごとに分離するため、永続化先を毎回新しくします。

```powershell
$env:K6_STATE = Join-Path $env:TEMP ("orewosabake-k6-" + [Guid]::NewGuid().ToString("N"))
.\node_modules\.bin\wrangler.cmd dev --config apps/web/wrangler.k6.jsonc --port 8787 --inspector-port 0 --persist-to $env:K6_STATE
```

この設定は偽キーとループバックURLのみを使います。テスト用Worker設定では、レート制限を負荷試験向けに上げています。通常のWorkerコードと本番向けレート制限は変わりません。

## 3. 機能スモーク

3つ目のPowerShellで実行します。

```powershell
$env:BASE_URL = "http://127.0.0.1:8787"
node_modules/.cache/k6-portable/k6-v2.3.0-windows-amd64/k6.exe run tests/k6/observe.js
```

各API応答の形とHTTPコードに加えて、偽Geminiの受信回数を照合し、再試行回数が上限通りか、クォータ・認証・不正応答で再試行していないかを確認します。

## 4. ローカル負荷プロファイル

偽Gemini APIとWorkerを起動したまま実行します。

```powershell
$env:BASE_URL = "http://127.0.0.1:8787"
$env:K6_PROFILE = "load"
node_modules/.cache/k6-portable/k6-v2.3.0-windows-amd64/k6.exe run tests/k6/observe.js
```

既定値は5 req/sを10秒間です。しきい値は失敗率1%未満、p95 1秒未満、drop 0です。`K6_RATE` と `K6_MAX_VUS` で負荷を調整できます。これは同じローカルDurable Objectに対する動作確認であり、Google Geminiの応答速度やCloudflare本番の処理能力を測るベンチマークではありません。

スモーク終了後、偽APIを起動したPowerShellで `Ctrl+C` を押すと、シナリオ別の受信回数が表示されます。

## 実行結果（2026-11-03）

- Workerの機能スモーク: 12 APIシナリオ、全25チェック成功。偽APIのシナリオ別受信回数も一致。API応答のp95は673.82 ms。HTTP失敗率は46.15%だが、クォータ・タイムアウト・不正出力など期待したエラーを含むため、スモークでは各ステータスと内容を検証している。
- Worker負荷プロファイル: 5 req/sを10秒、50リクエスト。失敗0、drop 0、p95 40.17 ms。
- 使用画像・Gemini応答は合成値。Google APIキー、本番Worker、Cloudflareアカウントへのアクセスは使用していない。
