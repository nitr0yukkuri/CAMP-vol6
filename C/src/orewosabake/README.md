# 俺をさばけ — 開発ガイド

[作品の紹介・公開デモ・使い方はルートのREADMEへ](../../../README.md)

React + TypeScriptの魚種別ガイドと、MediaPipeによる端末内の頭・尾検出、Geminiによる静止画の工程確認を組み合わせた試作です。

## ローカルで起動する

このREADMEのコマンドは、`C/src/orewosabake` から実行します。Node.js **24.22.1**（`.nvmrc`）、npm **11.19.1**（`packageManager`）を使用し、依存関係は `package-lock.json` から復元します。

```powershell
npm ci
npm run dev:web
```

画面は [http://127.0.0.1:5173](http://127.0.0.1:5173) です。ViteのCloudflareプラグインがReact画面とWorker APIを一緒に起動します。魚の検索・カテゴリ切替・選択から、回転案内、横画面のガイドへ進めます。

### Node.js版APIを確認する

別ターミナルで次を実行すると、Node.js標準HTTPサーバー版のAPIを確認できます。

```powershell
npm run dev:api
```

既定のアドレスは `http://127.0.0.1:3001` です。Node版はメモリ内、Worker版はDurable ObjectのSQLiteストレージにセッションを保持します。Webの開発画面はWorker APIを利用します。

### Gemini APIの設定

利用する実行環境に合わせて、次のファイルに設定します。どちらもGit管理対象外です。

| 実行環境 | 設定先 |
| --- | --- |
| `npm run dev:web` のローカルWorker | `apps/web/.dev.vars` |
| `npm run dev:api` のNode.js API | プロジェクト直下の `.env` |

```env
GEMINI_API_KEY=Google_AI_StudioのAPIキー
GEMINI_MODEL=gemini-3.5-flash-lite
```

本番のWorkerには、次のコマンドでAPIキーを登録します。APIキーはプロンプトへ入力し、`VITE_`付きの環境変数やフロントエンドのコードには入れないでください。

```powershell
npx wrangler secret put GEMINI_API_KEY --config apps/web/wrangler.jsonc
```

## 認識と自動進行の役割

| 処理 | 現在の実装 |
| --- | --- |
| 頭・尾の検出 | MediaPipe Tasks Vision / TFLite。ブラウザーのWeb Workerで約1秒ごとに推論 |
| 工程の見た目 | WorkerまたはNode API経由のGemini。サーモンでは工程開始時と現在の静止画を比較 |
| 自動進行 | 有効なWorkerセッションで、対象工程をGeminiが完了と判定した場合に1工程進行 |
| 手動確認 | うろこ・骨、サーモンの任意の皮処理、解凍・加熱、目標状態不明の工程、汎用ガイド、ローカル代替セッション |

MediaPipeは頭・尾の位置候補を検出するモデルです。魚捌き工程や切除の有無を判定する専用モデルではありません。Geminiは工程画像で追加学習していないゼロショットの試作です。公開モデルは俯瞰写真で学習しており、まな板・手・包丁が映るスマホ撮影での精度は未検証です。

カメラの連続映像は端末内で処理します。頭・尾の検知が安定した後、送信前の人物チェックを通過した圧縮JPEGだけをGeminiへ自動送信します。送信間隔は10秒以上あけ、失敗時は15秒・30秒・60秒後に最大3回再試行します。

自動進行には `certainty=observed` と `stepAssessment.status=likely_complete`、カメラ・セッション・現在工程の整合が必要です。完了判定1回を受けて約1.5秒の表示後に進み、魚体状態ラベルは参考表示として扱います。うろこや骨などの手動確認工程は自動で進めません。

対応ブラウザーでは、ガイド開始時に「次へ」の音声認識を起動します。音声認識はブラウザーによって外部サービスへ送られる場合があります。ガイドを閉じるとカメラの映像トラック・推論タスク・音声認識を停止します。

## ガイドの対象範囲

アプリの目標は、可食部の身を骨から外した状態まで案内することです。その後の切り分けや刺身などの調理は利用者に委ねます。魚種ごとの確認済みガイドに従い、不要な皮・骨の処理を一律には追加しません。

バックエンドは魚種ごとに骨から身を外す完了工程を指定し、その後に柵・切り身へ整える工程や調理工程があれば返さないようにします。根拠資料が骨から身を外すところまでを案内しない魚種は、対応ガイドなしとして返します。手順は公開資料をもとにした要約で、調理経験者によるレビューはまだ済んでいません。

頭・尾検知が位置を確認し、Geminiが現在の工程の見た目を参考判定します。Geminiが対象工程を完了と判定し、カメラ・セッション・工程が有効な場合に、見た目で確認できる工程だけ自動で次へ進みます。サーモンでは工程開始時と現在の画像を比較して魚体状態も確認します。うろこ・骨の確認とサーモンの任意の皮処理、解凍・加熱など人の確認が必要な工程、目標状態が不明な工程、その他の魚の汎用ガイド、ローカル代替セッションは手動進行です。どの結果も作業完了・安全性・鮮度を保証するものではありません。

実写データを集める場合は、[data/phone-capture/README.md](data/phone-capture/README.md)のラベル仕様とCSVテンプレートを参照してください。公開アプリには研究用撮影画面への導線はありません。画像とCSVを同じフォルダーにまとめ、`frame_path`を合わせて管理します。CSVの工程ラベルだけで現在の頭・尾検出器を再学習することはできず、物体検出には別途バウンディングボックスの正解ラベルが必要です。現時点で実際のスマホ撮影データはまだ含まれていません。

学習したモデルは `apps/web/public/models/head-tail.tflite` にローカル配置されます（約10.5 MB）。モデル本体は`.gitignore`対象なのでGitには含まれませんが、このファイルがある端末でビルド・デプロイすると静的アセットとして含まれます。Cloudflare Workersの[単一静的アセット上限25 MiB](https://developers.cloudflare.com/workers/platform/limits/)未満です。別環境では後述の学習手順を実行するか、モデルを安全に配布してください。

## Cloudflare Workersへデプロイ

初回はCloudflareアカウントを接続します。

```powershell
npx wrangler login
```

その後、プロジェクトフォルダから実行します。

```powershell
npm run deploy:cloudflare
```

React画面と魚画像は静的アセットとして、`/api/*`は同じオリジンのWorkerとして公開します。ローカルの画面確認は`npm run dev:web`で行えます。Node版APIを単独で確認する場合は、従来どおり`npm run dev:api`を使います。

Cloudflareアカウントにログインする前に一時プレビューを作る場合は、`npm run deploy:cloudflare:temporary`を使います。公開URLと引き継ぎリンクが発行され、引き継ぎリンクは60分以内にCloudflareアカウントへ登録する必要があります。

デプロイ前に、無視対象の学習済みモデルがローカルにあり、TFLite形式のヘッダーを持ち、単一アセット上限未満であることを確認します。新しいチェックアウトでは [ml/README.md](ml/README.md) の学習手順を実行してモデルを用意してください。

### GitHub Actionsで自動デプロイ

`.github/workflows/cloudflare-deploy.yml` は、`main` にアプリの実行コードやビルド設定が反映されたときに、型チェックとビルドを行ってCloudflare Workersへデプロイします。PRを `main` にマージした場合も、`main` へのpushとして実行されます。撮影データや説明文だけの変更ではデプロイしません。同時に複数の更新が入った場合は、本番デプロイを並列実行しません。準備完了後はGitHub Actions画面から `main` ブランチを選んで手動再実行することもできます。

GitHubリポジトリの **Settings → Secrets and variables → Actions** に、次のRepository secretsを登録してください。

| Secret | 値 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 対象アカウントだけに範囲を絞ったWorkers編集用APIトークン |
| `CLOUDFLARE_ACCOUNT_ID` | デプロイ先CloudflareアカウントのID |

APIトークンはCloudflareの「Edit Cloudflare Workers」権限を選び、対象アカウントに限定してください。トークンをソースコードやGitHub Actionsのログに書かないでください。
アカウントIDとAPIトークンの作成方法は[Cloudflare公式のGitHub Actions手順](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)を参照してください。

本番WorkerではCloudflare側にもキー登録が必要です。`npx wrangler secret put GEMINI_API_KEY --config apps/web/wrangler.jsonc`を実行し、プロンプトにAPIキーを入力してください。

**モデルの受け渡しも必要です。** `head-tail.tflite` はGit管理対象外なので、ワークフローは同じGitHubリポジトリのReleaseから `head-tail-model.zip` を取得します。ZIPにはルート直下に `head-tail.tflite` だけを入れてください。GitHubの **Settings → Secrets and variables → Actions → Variables** に次を登録します。`HEAD_TAIL_MODEL_SHA256` はZIPではなく、展開後のTFLiteファイルのSHA-256です。

| Variable | 値 |
| --- | --- |
| `HEAD_TAIL_MODEL_RELEASE_TAG` | モデルを添付したGitHub Releaseのタグ名（英数字、ピリオド、ハイフン、アンダースコア） |
| `HEAD_TAIL_MODEL_SHA256` | 添付モデルの64桁SHA-256 |

Windowsでは、モデルのSHA-256を次のコマンドで確認できます。

```powershell
Get-FileHash .\apps\web\public\models\head-tail.tflite -Algorithm SHA256
```

ZIPが破損している、ルート直下に `head-tail.tflite` 以外のファイルを含む、展開後のモデルが25 MiB以上、またはモデルのSHA-256が一致しない場合は公開を止めます。モデルはサイトから配信される公開アセットなので、Releaseにも公開されます。GitHub Secretにモデル本体を入れる必要はありません。

工程判定用モデルは別途任意の魚種別ファイルです。未配置でも頭・尾のモデルがあればサイトを公開でき、画面は工程判定を利用不可として扱います。

## API

`apps/api` はNode.js標準HTTPサーバーで、魚種別の参考手順とメモリ内の進行セッションを提供します。開発時の既定アドレスは `http://127.0.0.1:3001` です（`PORT` と `HOST` で変更できます）。

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | API稼働確認 |
| GET | `/api/catalog` | 魚種・「可食部を骨から外す」目的と魚種別ガイド提供状況 |
| GET | `/api/guide?fishId=hamachi` | 魚種IDに対応する参考手順を取得 |
| POST | `/api/guide` | 魚種名またはカタログIDから参考手順を取得 |
| POST | `/api/guide/analyze` | 顔チェック後の静止画をGeminiで確認。サーモンだけ魚体状態と工程の見た目を別々に返す |
| POST | `/api/guide/sessions` | 選んだ魚の参考手順で進行セッションを開始 |
| GET | `/api/guide/sessions/{sessionId}` | 現在の工程と進行状態を取得 |
| POST | `/api/guide/sessions/{sessionId}/advance` | ボタン・音声、または自動進行対象の画像判定で1工程だけ進める |
| GET | `/api/model/status` | API/Worker側の静的なモデル状態（ブラウザー推論とは独立） |
| GET | `/api/model/mock-observation` | UI確認用のサンプル検出結果 |
| GET | `/api/config/orientation` | 調理ガイド画面の推奨向き（横向き・案内表示） |

全レスポンスはJSONで、キャッシュされません。POST /api/guide は、魚選択画面が送る魚コンテキスト形式 { "fishName": "ハマチ", "fishCategory": "saltwater", "fishState": "unknown" }、またはカタログ形式 { "fishId": "hamachi", "preparationId": "edible_portion" } を受け取り、JSON形式・最大16 KiB・各スキーマを検証します。カタログ形式では魚種別のガイド提供状況を照合します。参考ガイドは、魚種ごとに定めた「骨から身を外す」完了工程まで返し、その後の柵・切り身への加工や料理は含めません。現在の資料がその完了工程を扱わないマグロ・鮎は、ガイドなしとして返します。カタログ外の魚は、購入店への確認を案内する一般ガイドに限定します。ガイド内容は経験者レビュー前であり、実地での安全確認や切り方の最終承認は済んでいません。未定義のパスは404、許可されていないメソッドは405を返します。POST /api/guide/analyzeは工程完了見込み（likely_complete/in_progress/uncertain）を返し、サーモンだけ魚体の見た目状態（whole_fish/opened/head_removed/filleting/filleted/unknown）も別フィールドで返します。サーモンでは工程開始時と現在のJPEGを一枚ずつ使い、各画像2 MiB・合計4 MiB以下に制限します。自動確認はMediaPipeで頭または尾の検知が安定した時だけ、同一タブで10秒以上間隔をあけて実行します。自動進行対象の工程では、`certainty=observed`かつ工程完了見込みが`likely_complete`の場合に自動で進みます。魚体状態ラベルと目標状態の一致は進行条件にしません。うろこ・骨などの手動確認工程はボタンや音声で進めます。ライブ映像は送信せず、AIは作業の安全性・鮮度を保証しません。

ChatGPT Sitesなど静的ホストではWorker APIを同梱していないため、画面は同じ魚別参考手順を使う端末内セッションに切り替えます。この場合の進行状態は画面を閉じると消えます。Cloudflare WorkerではDurable Objectのセッションを使い、Node版APIではメモリ内セッションを使います。

Gemini画像確認の指示と制約は [apps/api/prompts/fish-guide.md](apps/api/prompts/fish-guide.md) にあります。表示中の参考ガイドだけを根拠にし、画像だけで工程完了や安全性を断定しません。Workerの画像確認はIPごとに1分10回、アプリ全体でUTC日付あたり500回までです。全体上限は `apps/web/wrangler.jsonc` の `GEMINI_DAILY_ANALYSIS_LIMIT` で調整できます。自動確認には同一タブ内の10秒クールダウンもあります。頭・尾の検出がない映像はGeminiへ送信しません。

工程進行APIは魚種ごとの参考手順をセッションに保存します。セッション開始には `POST /api/guide/sessions` へ魚種・目的を送り、次へ進むときは現在の `stepId` と `source`（`button`、`voice`、または自動進行の`vision`）を送ります。ガイド開始時にブラウザーの音声認識を起動し、マイクが許可された場合は「次へ」を自動で聞き取ります。認識した `transcript: "次へ"` を受け取り、現在の工程IDと一致する時だけ進みます。音声認識が利用できない場合は画面のボタンで進めます。音声自体はアプリに保存しません。Cloudflare環境ではセッションと進捗をDurable ObjectのSQLiteストレージに保存するため、Workerの再起動後も利用できます。ローカルNode APIではメモリ内だけに保持され、API再起動で消えます。保持セッションは最大500件で、`updatedAt`から30分経過したものは次のAPIリクエストまたはDurable Objectの期限アラームで削除されます。上限到達時は `503 SESSION_CAPACITY_REACHED` を返します。公開Workerではクライアントごとに開始枠10件を持つトークンバケットで制限し、10秒ごとに1件分を補充します。上限時は `429 SESSION_RATE_LIMITED` と `Retry-After` を返します。Cloudflareが付与する `CF-Connecting-IP` をSHA-256でハッシュした値を制限キーにします。生IPはDBに保存しませんが、ハッシュも匿名化ではないため、トークン枠が補充される期限（最大100秒）に合わせてDurable Objectの期限アラームで削除します。これは単一IPからの連続作成を抑える対策で、複数IPを使う分散リクエストすべてを防ぐものではありません。Geminiの画像確認は参考情報であり、試作の自動送りは対象工程を限定しています。

## 学習実験

学習対象はMendeleyのYOLOラベルに合わせた `head` / `tail` 物体検出です。セットアップ・分割・学習方法・MediaPipeの制約は [ml/README.md](ml/README.md) を参照してください。

- 学習: WSL UbuntuのPython 3.10環境でMediaPipe Model Maker / MobileNetV2 I320をCPUで30エポック
- 評価: 撮影日単位で分けた検証21枚・テスト26枚。ブラウザーと同じ検出上限12件・しきい値0.35・IoU 0.5でテストmacro F1 0.8002（head 0.8718、tail 0.7287）、AP50 0.7943
- 実行時互換: 出力TFLiteをMediaPipe Tasks ObjectDetectorでロードし、テスト画像で推論して確認済み
- 見逃し分析・推論条件の比較・モデルSHA-256: `ml/generated/output/metrics.json`（Git管理外）。失敗画像18枚の比較図: `ml/generated/output/error-analysis.png`（Git管理外）
- データの適合性・ライセンス・追加の公開候補（ChangeIt / HowToChange / FishCutなど）の監査: [data/analysis/dataset-audit.md](data/analysis/dataset-audit.md)。Mendeley学習元の帰属表示と利用条件: [ml/README.md](ml/README.md)。
- Mendeleyの200枚だけでは魚捌き工程を認識できません。工程認識には別途スマホ撮影データが必要です。

CPUでの初回画像学習として、正解枠から切り出したhead/tail分類器（HOG + ロジスティック回帰）を実際に学習しました。撮影日ホールドアウトでcrop accuracy 75.8%です。これは全画面の物体検出器ではありません。手法、誤分類画像、評価上の限界は [ml/hog-experiment-report.md](ml/hog-experiment-report.md) を参照してください。

## ディレクトリ

- `apps/web`: React + TypeScriptの魚種別ガイド画面、MediaPipe推論アダプター
- `apps/api`: Node.js + TypeScriptのローカルAPI
- `packages/contracts`: APIスキーマと型を共有
- `ml`: データ変換、CPU crop分類、物体検出の学習準備
- `data`: 公開データの監査、撮影計画、ローカルデータ
