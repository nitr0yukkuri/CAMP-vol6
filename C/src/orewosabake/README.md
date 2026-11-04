# 俺をさばけ — AI試作

React + TypeScriptの魚選択・手順画面と、MediaPipe Tasksによる頭・尾の位置検出を備えた試作です。魚捌き工程や切除の有無を認識するモデルはありません。

## React UIを起動

Node.js `24.22.1` と npm `11.19.1` に固定しています（`.nvmrc` / `packageManager`）。React・React DOMは `19.3.1`、全依存パッケージのバージョンはロックファイルと各workspace manifestで固定しています。

```powershell
npm ci
```

ターミナルを2つ開き、プロジェクトフォルダからそれぞれ起動します。

```powershell
npm run dev:api
```

```powershell
npm run dev:web
```

画面は `http://127.0.0.1:5173` です。魚の検索・カテゴリ切替・選択から、縦画面の回転案内、横画面のガイドへ進めます。カメラは「俺を捌け！」を押した後にだけ起動します。通常の映像は端末内で処理します。MediaPipeが頭または尾を安定して検知した後、顔チェックを通った静止画だけをGeminiへ自動送信します。サーモンでは工程開始時の画像と現在の画像を比較し、魚体の状態と現在工程の完了見込みを別々に返します。Geminiの応答は学習済み分類器ではなく、学習データも使わないゼロショット試作です。Geminiが対象工程を「できていそう」と判定すると、見た目で確認できる工程は自動で次へ進みます。うろこ・骨の確認、解凍・加熱など人の確認が必要な工程と、目標状態が不明な工程は手動です。送信間隔は10秒以上あけ、失敗時は15秒・30秒・60秒後に最大3回再試行します。カメラを終了すると映像トラックと推論タスクを停止します。

### Gemini APIの設定

プロジェクト直下の`.env`にAPIキーとモデルを設定します。`.env`はGit管理対象外です。

```env
GEMINI_API_KEY=Google_AI_StudioのAPIキー
GEMINI_MODEL=gemini-3.5-flash-lite
```

Node APIはプロジェクト直下の`.env`を読み込みます。`npm run dev:web`のCloudflare Worker開発環境では、同じ2行を`apps/web/.dev.vars`にも設定してください。このファイルもGit管理対象外です。Cloudflareへデプロイするときは、`npx wrangler secret put GEMINI_API_KEY --config apps/web/wrangler.jsonc`でキーを登録します。APIキーを`VITE_`付きの環境変数にしたり、フロントエンドへ書いたりしないでください。

魚選択画面には21種類があります。魚種ごとの参考手順は公開資料をもとに用意し、APIは可食部の身を骨から外す完了工程までを返します。マグロと鮎は現在の資料がこの目的に合わないためガイド対象外です。参考手順は調理経験者によるレビュー前です。カタログ外の魚には一般的な三枚おろし手順を表示せず、種類や処理方法に迷った場合は購入店に確認するよう案内します。頭・尾モデルが配置されると、カメラ映像から作ったフレームを専用Web Workerへ渡し、ブラウザー内で約1秒ごとに推論して検出枠を表示します。モデルとMediaPipe WASMは同じサイトから読み込みます。映像フレームは常時APIや外部サービスへ送りません。ガイド画面では、MediaPipeの安定検知と人物チェック後に縮小JPEG静止画をAPI経由でGemini 3.5 Flash-Liteへ送ります。サーモン選択中は工程の開始時と現在の静止画を比較し、魚体状態と工程完了見込みを別々に確認します。Geminiはゼロショットの試作であり、魚の工程画像で追加学習していません。MediaPipeは頭・尾の位置検出で、魚体状態や工程完了は判定しません。自動進行は頭尾検知が有効なCloudflare Worker利用時に限り、Geminiが対象工程を完了と判定した時に行います。サーモンでは魚体状態も目標と一致する必要があります。うろこ・骨の確認、解凍・加熱など人の確認が必要な工程、目標状態が不明な工程、その他の魚の汎用ガイドとローカル代替セッションは手動です。AI判定は安全や作業完了を保証しません。

この試験モデルは公開データの俯瞰写真で学習しています。まな板・手・包丁が映るスマホ撮影では未検証のため、検出枠は参考表示として扱ってください。

## ガイドの対象範囲

アプリの目標は、可食部の身を骨から外した状態まで案内することです。その後の切り分けや刺身などの調理は利用者に委ねます。魚種ごとの確認済みガイドに従い、不要な皮・骨の処理を一律には追加しません。

バックエンドは魚種ごとに骨から身を外す完了工程を指定し、その後に柵・切り身へ整える工程や調理工程があれば返さないようにします。根拠資料が骨から身を外すところまでを案内しない魚種は、対応ガイドなしとして返します。手順は公開資料をもとにした要約で、調理経験者によるレビューはまだ済んでいません。

頭・尾検知が位置を確認し、Geminiが現在の工程の見た目を参考判定します。Geminiが対象工程を完了と判定し、カメラ・セッション・工程が有効な場合に、見た目で確認できる工程だけ自動で次へ進みます。サーモンでは工程開始時と現在の画像を比較して魚体状態も確認します。うろこ・骨の確認、解凍・加熱など人の確認が必要な工程、目標状態が不明な工程、その他の魚の汎用ガイド、ローカル代替セッションは手動進行です。どの結果も作業完了・安全性・鮮度を保証するものではありません。

スマホ視点の検証データを集める場合は、魚選択画面の「研究用データを撮る」からカメラを明示的に起動し、工程・頭尾の状態を手動で付けて静止画を保存できます。画像は最大832pxのJPEGとして個別に端末へダウンロードし、ラベルはCSVで出力します。映像・画像・CSVのサーバー送信はありません。実機スマホから使うにはHTTPSで配信されたURLが必要です（ローカルの`127.0.0.1`は開発PC内だけのアドレスです）。画像とCSVを同じフォルダーにまとめ、`data/phone-capture/README.md`の手順に沿って`frame_path`を合わせてください。このラベルCSVには物体検出用のバウンディングボックスがないため、撮影しただけで現在のhead/tail検出器を再学習するものではありません。現時点で実際のスマホ撮影データはまだ含まれていません。

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
| POST | `/api/guide/sessions/{sessionId}/advance` | ボタン・音声、またはサーモン試作の条件一致した画像判定で1工程だけ進める |
| GET | `/api/model/status` | API/Worker側の静的なモデル状態（ブラウザー推論とは独立） |
| GET | `/api/model/mock-observation` | UI確認用のサンプル検出結果 |
| GET | `/api/config/orientation` | 調理ガイド画面の推奨向き（横向き・案内表示） |

全レスポンスはJSONで、キャッシュされません。POST /api/guide は、魚選択画面が送る魚コンテキスト形式 { "fishName": "ハマチ", "fishCategory": "saltwater", "fishState": "unknown" }、またはカタログ形式 { "fishId": "hamachi", "preparationId": "edible_portion" } を受け取り、JSON形式・最大16 KiB・各スキーマを検証します。カタログ形式では魚種別のガイド提供状況を照合します。参考ガイドは、魚種ごとに定めた「骨から身を外す」完了工程まで返し、その後の柵・切り身への加工や料理は含めません。現在の資料がその完了工程を扱わないマグロ・鮎は、ガイドなしとして返します。カタログ外の魚は、購入店への確認を案内する一般ガイドに限定します。ガイド内容は経験者レビュー前であり、実地での安全確認や切り方の最終承認は済んでいません。未定義のパスは404、許可されていないメソッドは405を返します。POST /api/guide/analyzeは工程完了見込み（likely_complete/in_progress/uncertain）を返し、サーモンだけ魚体の見た目状態（whole_fish/opened/head_removed/filleting/filleted/unknown）も別フィールドで返します。サーモンでは工程開始時と現在のJPEGを一枚ずつ使い、各画像2 MiB・合計4 MiB以下に制限します。自動確認はMediaPipeで頭または尾の検知が安定した時だけ、同一タブで10秒以上間隔をあけて実行します。サーモンの一部の工程だけ、魚体状態が目標に一致し、工程完了見込みが `likely_complete` の場合に自動で進みます。画像で完了を判断できないうろこ取りと骨・小骨確認、および他魚種は手動操作のままです。ライブ映像は送信せず、AIは作業の安全性・鮮度を保証しません。

ChatGPT Sitesなど静的ホストではWorker APIを同梱していないため、画面は同じ魚別参考手順を使う端末内セッションに切り替えます。この場合の進行状態は画面を閉じると消えます。Cloudflare WorkerではDurable Objectのセッションを使い、Node版APIではメモリ内セッションを使います。

Gemini画像確認の指示と制約は [apps/api/prompts/fish-guide.md](apps/api/prompts/fish-guide.md) にあります。表示中の参考ガイドだけを根拠にし、画像だけで工程完了や安全性を断定しません。Workerの画像確認はIPごとに1分10回、アプリ全体でUTC日付あたり500回までです。全体上限は `apps/web/wrangler.jsonc` の `GEMINI_DAILY_ANALYSIS_LIMIT` で調整できます。自動確認には同一タブ内の10秒クールダウンもあります。頭・尾の検出がない映像はGeminiへ送信しません。

工程進行APIは魚種ごとの参考手順をセッションに保存します。セッション開始には `POST /api/guide/sessions` へ魚種・目的を送り、次へ進むときは現在の `stepId` と `source`（`button`、`voice`、またはサーモン試作の`vision`）を送ります。音声の場合はブラウザ側で音声認識した `transcript: "次へ"` が必要です。現在の工程IDと一致しない操作、認識された言葉が「次へ」でない操作では進みません。Cloudflare環境ではセッションと進捗をDurable ObjectのSQLiteストレージに保存するため、Workerの再起動後も利用できます。ローカルNode APIではメモリ内だけに保持され、API再起動で消えます。保持セッションは最大500件で、`updatedAt`から30分経過したものは次のAPIリクエストまたはDurable Objectの期限アラームで削除されます。上限到達時は `503 SESSION_CAPACITY_REACHED` を返します。公開Workerではクライアントごとに開始枠10件を持つトークンバケットで制限し、10秒ごとに1件分を補充します。上限時は `429 SESSION_RATE_LIMITED` と `Retry-After` を返します。Cloudflareが付与する `CF-Connecting-IP` をSHA-256でハッシュした値を制限キーにします。生IPはDBに保存しませんが、ハッシュも匿名化ではないため、トークン枠が補充される期限（最大100秒）に合わせてDurable Objectの期限アラームで削除します。これは単一IPからの連続作成を抑える対策で、複数IPを使う分散リクエストすべてを防ぐものではありません。Geminiの画像確認は参考情報であり、試作の自動送りは対象工程を限定しています。

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
