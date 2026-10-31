# 俺をさばけ — AI試作

`C/src/orewosabake` 内だけで作業する、頭・尾検出の学習準備とUIモックです。魚捌き工程を認識するモデルはまだありません。

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

画面は `http://127.0.0.1:5173` です。魚の検索・カテゴリ切替・選択から、縦画面の回転案内、横画面のガイドへ進めます。カメラは「俺を捌け！」を押した後にだけ起動し、映像をアップロード・保存しません。カメラを終了すると映像トラックを停止します。

工程ガイドはモックAPIの内容です。頭・尾の位置検出用モデルは未配置で、魚の捌き工程は認識しません。ガイドの工程は利用者が手動で進めます。

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
| GET | `/api/model/status` | 学習済みモデルの状態（現在は未学習） |
| GET | `/api/model/mock-observation` | UI確認用のサンプル検出結果 |
| GET | `/api/config/orientation` | 調理ガイド画面の推奨向き（横向き・案内表示） |

全レスポンスはJSONで、キャッシュされません。`POST /api/guide` は `{ "fishId": "aji", "preparationId": "edible_portion" }` の形式を受け取り、JSON形式・最大16 KiB・選択IDを検証します。ガイドは魚から可食部を取り出したところで終了し、その後に三枚おろしや刺身などをどうするかは利用者に委ねます。完了条件の細部は魚種ごとの確認済みガイドで定義します。有効な選択でも現時点では `503 GUIDE_NOT_CONFIGURED` を返します。カタログの魚種・目的は選択UI用の候補で、対応済みガイドを意味しません。未定義のパスは `404`、許可されていないメソッドは `405` を返します。向き設定はAPIから取得できますが、端末の向き検出と回転を促す表示はフロントエンドで実装する必要があります。魚種別の検証済み手順、画像アップロード、AI解析はまだ提供していません。現在のデータはモックであり、実際の捌き方や安全性を示すものではありません。学習設計上、カメラ映像は端末内処理を想定しており、APIに画像を送信・保存する機能はありません。

AIを接続する際の日本語プロンプト案は [apps/api/prompts/fish-guide.md](apps/api/prompts/fish-guide.md) にあります。確認済みガイドだけを根拠にし、画像だけで工程完了や安全性を断定しない設計です。AIサービス固有の画像形式・JSON出力設定は、サービス選定後に合わせます。

工程進行APIは現在モックガイドを使います。セッション開始には `POST /api/guide/sessions` へ魚種・目的を送り、次へ進むときは現在の `stepId` と `source`（`button` または `voice`）を送ります。音声の場合はブラウザ側で音声認識した `transcript: "次へ"` が必要です。現在の工程IDと一致しない操作、認識された言葉が「次へ」でない操作では進みません。セッションと進捗はメモリ内だけに保持され、API再起動で消えます。保持セッションは最大500件で、`updatedAt`から30分経過したものは次のAPIリクエスト時に削除されます。上限到達時は `503 SESSION_CAPACITY_REACHED` を返します。AIによる画像確認や工程判定は未接続なので、現状の進行結果はモックガイド上のものです。カメラ映像から工程を自動認識したり、検出結果で自動進行したりはしません。

## 学習実験

学習対象はMendeleyのYOLOラベルに合わせた `head` / `tail` 物体検出です。セットアップ・分割・学習方法・MediaPipeの制約は [ml/README.md](ml/README.md) を参照してください。

- 学習準備のみ: `python ml/train_detector.py --prepare-only --force`
- 学習環境: Python 3.10の仮想環境とMediaPipe Model Maker
- 出力: MediaPipe Tasks Object Detector互換を意図したTFLite。実モデルでの互換確認が必要です。
- Mendeleyの200枚だけでは魚捌き工程を認識できません。工程認識には別途スマホ撮影データが必要です。

CPUでの初回画像学習として、正解枠から切り出したhead/tail分類器（HOG + ロジスティック回帰）を実際に学習しました。撮影日ホールドアウトでcrop accuracy 75.8%です。これは全画面の物体検出器ではありません。手法、誤分類画像、評価上の限界は [ml/hog-experiment-report.md](ml/hog-experiment-report.md) を参照してください。

## ディレクトリ

- `apps/web`: React + TypeScript UIモック、MediaPipe推論アダプター
- `apps/api`: Node.js + TypeScriptの読み取り専用モックAPI
- `packages/contracts`: APIスキーマと型を共有
- `ml`: データ変換、CPU crop分類、物体検出の学習準備
- `data`: 公開データの監査、撮影計画、ローカルデータ
