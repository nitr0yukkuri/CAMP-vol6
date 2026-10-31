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

画面は `http://127.0.0.1:5173` です。魚の検索・カテゴリ切替・選択から、縦画面の回転案内、横画面のガイドへ進めます。カメラは「俺を捌け！」を押した後にだけ起動し、映像をアップロード・保存しません。カメラを終了すると映像トラックと推論タスクを停止します。

アジ・サバ・タイはモックAPIのガイドセッションと同期して手動で進めます。それ以外の魚は魚種別ガイドがないため共通の表示モックです。頭・尾モデルが配置されると、カメラ映像から作ったフレームを専用Web Workerへ渡し、ブラウザー内で約1秒ごとに推論して検出枠を表示します。モデルとMediaPipe WASMは同じサイトから読み込みます。映像フレームはAPIや外部サービスへ送りません。頭・尾の検出だけで切除や工程完了を断定せず、ガイドは利用者が手動で進めます。

この試験モデルは公開データの俯瞰写真で学習しています。まな板・手・包丁が映るスマホ撮影では未検証のため、検出枠は参考表示として扱ってください。

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

React画面と魚画像は静的アセットとして、`/api/*`は同じオリジンのWorkerとして公開します。ローカルの画面確認は`npm run dev:web`で行えます。Node版モックAPIを単独で確認する場合は、従来どおり`npm run dev:api`を使います。

Cloudflareアカウントにログインする前に一時プレビューを作る場合は、`npm run deploy:cloudflare:temporary`を使います。公開URLと引き継ぎリンクが発行され、引き継ぎリンクは60分以内にCloudflareアカウントへ登録する必要があります。

デプロイ前に、無視対象の学習済みモデルがローカルにあり、TFLite形式のヘッダーを持ち、単一アセット上限未満であることを確認します。新しいチェックアウトでは [ml/README.md](ml/README.md) の学習手順を実行してモデルを用意してください。

## API

`apps/api` はNode.js標準HTTPサーバーで、画面モックが利用するJSON APIを提供します。開発時の既定アドレスは `http://127.0.0.1:3001` です（`PORT` と `HOST` で変更できます）。

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | API稼働確認 |
| GET | `/api/catalog` | 魚種・可食部の取り出し目的の選択肢とガイド提供状況 |
| GET | `/api/guide` | 現在の安全確認用ガイド表示モック |
| POST | `/api/guide` | 魚種・可食部を取り出す目的を検証してガイドを要求 |
| POST | `/api/guide/sessions` | 画面進行用のモックセッションを開始 |
| GET | `/api/guide/sessions/{sessionId}` | 現在の工程と進行状態を取得 |
| POST | `/api/guide/sessions/{sessionId}/advance` | ボタンまたは音声の明示操作で1工程だけ進める |
| GET | `/api/model/status` | API/Worker側の静的なモデル状態（ブラウザー推論とは独立） |
| GET | `/api/model/mock-observation` | UI確認用のサンプル検出結果 |
| GET | `/api/config/orientation` | 調理ガイド画面の推奨向き（横向き・案内表示） |

全レスポンスはJSONで、キャッシュされません。POST /api/guide は、魚選択画面が送る魚コンテキスト形式 { "fishName": "アジ", "fishCategory": "saltwater", "fishState": "unknown" } と、カタログ形式 { "fishId": "aji", "preparationId": "edible_portion" } のいずれかを受け取り、JSON形式・最大16 KiB・各スキーマを検証します。魚種別ガイドが未設定のため、有効な選択でも503 GUIDE_NOT_CONFIGUREDを返します。ガイドは魚から可食部を取り出したところで終了し、その後に三枚おろしや刺身などをどうするかは利用者に委ねます。完了条件の細部は魚種ごとの確認済みガイドで定義します。カタログの魚種・目的は選択UI用の候補で、対応済みガイドを意味しません。未定義のパスは404、許可されていないメソッドは405を返します。向き設定はAPIから取得できますが、端末の向き検出と回転を促す表示はフロントエンドで実装する必要があります。魚種ごとの検証済み手順や工程判定はまだ提供していません。現在のガイドはモックであり、実際の捌き方や安全性を示すものではありません。カメラ映像は端末内で推論し、APIに送信・保存しません。

AIを接続する際の日本語プロンプト案は [apps/api/prompts/fish-guide.md](apps/api/prompts/fish-guide.md) にあります。確認済みガイドだけを根拠にし、画像だけで工程完了や安全性を断定しない設計です。AIサービス固有の画像形式・JSON出力設定は、サービス選定後に合わせます。

工程進行APIは現在モックガイドを使います。セッション開始には `POST /api/guide/sessions` へ魚種・目的を送り、次へ進むときは現在の `stepId` と `source`（`button` または `voice`）を送ります。音声の場合はブラウザ側で音声認識した `transcript: "次へ"` が必要です。現在の工程IDと一致しない操作、認識された言葉が「次へ」でない操作では進みません。Cloudflare環境ではセッションと進捗をDurable ObjectのSQLiteストレージに保存するため、Workerの再起動後も利用できます。ローカルNode APIではメモリ内だけに保持され、API再起動で消えます。保持セッションは最大500件で、`updatedAt`から30分経過したものは次のAPIリクエスト時に削除されます。上限到達時は `503 SESSION_CAPACITY_REACHED` を返します。AIによる画像確認や工程判定は未接続なので、現状の進行結果はモックガイド上のものです。カメラ映像から工程を自動認識したり、検出結果で自動進行したりはしません。

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

- `apps/web`: React + TypeScript UIモック、MediaPipe推論アダプター
- `apps/api`: Node.js + TypeScriptの読み取り専用モックAPI
- `packages/contracts`: APIスキーマと型を共有
- `ml`: データ変換、CPU crop分類、物体検出の学習準備
- `data`: 公開データの監査、撮影計画、ローカルデータ
