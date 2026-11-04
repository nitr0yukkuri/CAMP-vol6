# 技術構成

確認基準: GitHub `main` のアプリ実装コミット `a73e49a9a0a9516e4ca593380d16076553356930`（2026-11-03）。この資料更新コミットは基準に含めない。

## 全体像

| 場所 | 技術 | 役割 |
| --- | --- | --- |
| ブラウザー | React、TypeScript、Vite | 魚種・手順の表示、カメラ、検知結果に応じたGemini確認 |
| ブラウザー内の別スレッド | Web Worker、MediaPipe Tasks Vision、TFLite | 頭・尾検知、BlazeFaceによる顔チェック、任意の工程分類を実行 |
| 公開バックエンド | Cloudflare Worker | 同一オリジンのAPI、Geminiへの中継 |
| セッション・制限 | Durable Objects + SQLite | ガイド進行と画像確認回数の管理 |
| 画像判定 | Google Gemini API | 静止画の見える範囲を参考判定 |
| 開発用バックエンド | Node.js API | ローカル開発・API確認。本番Workerとは別実装 |
| 学習 | Python、MediaPipe Model Maker | データ準備・TFLite学習・独立データ評価。HTTP中には学習しない |

図は[architecture-runtime-v2.html](./architecture-runtime-v2.html)を参照。図はスマートフォンでは縦型、広い画面ではロゴ付き構成図で表示する。ロゴ・アイコン・フォントの権利表記は[第三者素材の通知](./STACK-DIAGRAM-NOTICES.md)。PNG版は[architecture-runtime-v2.png](./architecture-runtime-v2.png)（2026-11-03、コミット `2127e62` 時点のスナップショット。現在の構成はHTML版を参照）。

## カメラから画面まで

1. 利用者がカメラを開始し、ブラウザーが `getUserMedia()` で映像を取得する。カメラ利用にはHTTPSまたはlocalhostが必要。
2. Web側が映像からフレームを作り、`ImageBitmap`をブラウザーのWeb Workerへ渡す。MediaPipe推論はUIのメインスレッド外で実行する。
3. `head-tail.tflite` をMediaPipe ObjectDetectorで実行する。モデルは `head` と `tail` の位置候補を返す。これは「切除済み」「うろこ取り中」などの工程分類モデルではない。
4. 現行mainには魚種別の工程TFLiteが配置されていない。読み込み用コードはあるが、ファイルがないと工程分類は利用できない。学習スクリプトが対象とするのは `whole`、`head_removed`、`gutted`、`filleting`、`finished` の5状態。これらは作業の動きや完了時刻を直接判定するものではない。

## Gemini画像確認の経路

- MediaPipeで頭または尾が3回連続して安定検出され、最新観察が2秒以内の場合に自動確認を開始する。同じ検知状態の送信は最低10秒間隔。
- 送信直前にFaceDetector（BlazeFace）で静止画を確認する。顔を検知した場合、モデルを読み込めない場合、チェックに失敗した場合は画像をGeminiへ送らない。顔検知の見逃しを完全に防ぐ保証ではない。
- ブラウザーはカメラの静止画1枚を `POST /api/guide/analyze` へ送る。Workerは共有契約、画像サイズ、クライアント別の短時間制限を確認し、Geminiへ転送する。APIキーはWorker Secretに置く。Durable Objectには全利用者共通のUTC日次上限（既定500回）もある。
- 一時的なネットワーク障害や上流429/5xxは最大2回まで試行する。上流クォータ・認証エラーや回答スキーマ不正は再試行しない。再試行はローカルの偽Gemini APIで検証しており、実Google APIの負荷試験ではない。
- 既定モデル名は `gemini-3.5-flash-lite`（`GEMINI_MODEL` で変更可能）。結果の `certainty: uncertain` は共有契約とUIで不確実として表示する。Geminiは工程完了や安全性を保証せず、ガイドを自動で次へ進めない。連続動画は送らない。

## APIと保存

主な公開WorkerのAPI:

- `GET /api/catalog`: 魚種とガイドのカタログ
- `GET /api/guide?fishId=...`、`POST /api/guide`: ガイド情報
- `POST /api/guide/sessions`、`GET /api/guide/sessions/{id}`: ガイドセッション開始・取得
- `POST /api/guide/sessions/{id}/advance`: 利用者の確認操作を受けて次の手順へ進む
- `POST /api/guide/analyze`: 静止画のGemini確認
- `GET /api/model/status`: API側のモデル状態情報

Durable Objectはセッション、クライアント別の1分10回制限、全利用者共通のUTC日次500回制限を扱う。画像そのものをガイドセッションへ保存しない。クライアント識別にはIPアドレスのハッシュを使う。Workerの画像上限は2,000,000 bytes。

Node APIはローカル開発用の独立実装であり、Cloudflare上の公開APIではない。WorkerとNode APIは共有契約を使うが、HTTP処理は別のため両経路の挙動は同じと決めつけない。

## モデルとデータ

- 公開モデル `head-tail.tflite` は魚の頭・尾の位置を検出する。評価に使った公開画像の結果を、調理台・人物・包丁を含むスマートフォン映像の精度として扱わない。
- 工程モデルは頭尾モデルとは別の分類器。魚・撮影セッションをまたがないtrain / validation / test分割と、各5状態の人手確認済み画像が必要。現在は工程画像データと公開工程モデルがなく、工程認識の実用精度を主張できない。
- 研究撮影画面で撮った画像とCSVは利用者が端末へ保存する。撮影しただけで学習データや公開モデルへ自動追加されない。
- AIの検出候補は人手ラベルではない。教師データへ使う前に画像ごとに確認・修正し、人物が入る素材は同意・保管・共有条件を確認する。

## CI・公開

mainにはCloudflare向けデプロイWorkflowがある。mainの対象変更または手動実行で、モデルReleaseの取得・形式・SHA-256を確認し、Worker型検査・Webビルドを実行してCloudflareへデプロイする構成。Geminiを使うにはWorker Secretの `GEMINI_API_KEY` が必要。

## 確認したコード

- `apps/web/src/App.tsx` — カメラ・安定検出・自動Gemini確認・手順UI
- `apps/web/src/model/mediapipeHeadTailDetector.ts` — ObjectDetectorと任意の工程分類器
- `apps/web/src/workers/headTailInference.worker.ts` — ブラウザーの推論Worker
- `apps/web/worker/index.ts` — 公開API、Gemini中継、Durable Object
- `apps/web/wrangler.jsonc` — Cloudflare WorkerとStatic Assets
- `apps/api/src/server.ts` — ローカルNode API
- `packages/contracts/src/index.ts` — 共有スキーマと型
- `ml/prepare_stage_capture.py`、`ml/train_stage_classifier.py` — 工程分類データ準備・学習
- `.github/workflows/cloudflare-deploy.yml` — デプロイWorkflow
- `.github/workflows/verify.yml` — PRとmain対象変更の型検査・Python構文・Webビルド
