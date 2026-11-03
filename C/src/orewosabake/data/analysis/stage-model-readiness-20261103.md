# 工程モデルの準備状況

確認日: 2026-11-03  
確認対象: GitHub `main` at `a73e49a9a0a9516e4ca593380d16076553356930`

## 結論

工程分類モデルはまだ学習・公開されていない。確認済みの工程画像がなく、公開モデルフォルダーにあるのは頭・尾検出用 `head-tail.tflite` のみ。これは「うろこ取り中」「内臓処理済み」などを分類するモデルではない。

## 手元で確認したデータとモデル

- `data/phone-capture/capture-manifest.csv` はヘッダーだけで、工程ラベル付き撮影行は0件。
- `ml/generated/fish-stage/` に工程分類用の生成データや学習結果はない。
- `apps/web/public/models/` には `head-tail.tflite` がある。魚の頭と尾の矩形を検出するモデルで、工程分類の重みではない。
- 公開データのMendeleyは頭・尾の位置、AutoFishは魚体マスク等をラベル付けしている。魚を捌く工程ラベルを持たない。
- `ml/prepare_stage_capture.py` と `ml/train_stage_classifier.py` は5つの既知状態（`whole`、`head_removed`、`gutted`、`filleting`、`finished`）を扱い、確認済みの工程外画像が各splitに揃う場合は任意の `unknown` 棄却クラスも学習できる。これは収集済みの工程外例だけを学ぶラベルで、あらゆる未知画像を見分ける保証ではない。いずれも実画像と人手確認が必要。
- MediaPipeの実行コードは、頭・尾のObjectDetectorと、任意で読み込む工程ImageClassifierを分けている。工程モデルが配置されていない環境で工程結果を返すことはできない。
- 研究撮影画面はカメラ画像とCSVを端末へ保存するための機能。画像ファイルをまとめて取り込むUIや、魚を切り抜くUIはmainに含まれない。

## 「魚の状態」と「作業中の動き」は別

状態分類は、静止画の魚が「未処理」「頭を外した後」などどの状態に近いかを分類する。うろこ取り・エラ取りのように魚の見た目が大きく変わらない作業は区別しにくく、5状態だけで作業動作を検出したとは言えない。

作業の開始・終了や工程変化を評価するには、時刻付きの撮影系列が必要。包丁の安全性、作業が正しく終わったこと、魚の鮮度などを画像分類結果から保証しない。

## 公開画像をそのまま工程データにできない理由

| データ | 収録内容 | 工程モデルに使えない理由 |
| --- | --- | --- |
| Mendeley head/tail | 200枚の頭・尾矩形 | 部位位置のラベルで、捌き状態や作業者の動作ではない |
| AutoFishの取得サンプル | 120枚、38個体、魚体マスクなど | コンベアの俯瞰画像で、まな板上の工程や工程遷移がない |
| FishCut | 頭を落としたヘイクの切断線 | 工場画像の切断位置タスク。現行5状態のラベルではなく、表示ライセンスも非商用条件 |
| Commons等の公開写真・動画 | うろこ取り、フィレ、調理済みなど混在 | 画像ごとに対象工程・権利・同一魚・撮影回を確認する必要があり、独立した全5状態セットにならない |
| LaksData / DaFiF | フィレ品質・鮮度 | 目的ラベルが工程状態と異なる |

候補の詳細、件数、ライセンス表示、確認リンクは[研究用データ収集レポート](./research-data-collection-20261102.md)を参照。カテゴリ内の件数や検索ヒット数を、確認済みラベルの数として数えない。

## 次に集めるデータ

1. 最初は魚種を1種（例: ハマチ）に固定し、5状態の定義を撮影前に確認する。
2. 同じ魚を追跡し、状態が変わる前後を含む代表画像と撮影時刻を記録する。工程名は撮影者が確認し、AIの推定を正解ラベルにしない。
3. 魚個体と撮影セッションを識別し、同じ魚や隣接フレームがtrain / validation / testをまたがないよう分割する。3分割には最低3つの独立グループが必要だが、3グループだけで実用精度が保証されるわけではない。
4. 明るさ、角度、手・包丁による遮蔽、画角外などを記録する。頭が画面にないだけで「切除済み」と付けない。
5. 独立testの混同行列、クラス別precision / recall / F1を確認する。遷移モデルを評価する場合は、画像正解率とは別に誤提案、見逃し、検出遅延を集計する。
6. 結果を確認するまで `fish-stage/<fishId>.tflite` へ配置しない。配置前に実際に使うスマートフォン・ブラウザーでモデル読み込み、カメラ再起動、画面回転を確認する。

## 実行環境の制約

2026-11-03の確認では、Windows側のPython 3.14環境にMediaPipe、TensorFlow、NumPyがなく、学習スクリプトを実行できなかった。WSLのPython 3.10は起動したが、学習依存は未導入。依存インストールやモデル学習は行っていない。学習環境を整える場合は必要容量とPython・MediaPipe Model Makerの対応版を先に確認する。

## 確認したファイル

- `data/phone-capture/capture-manifest.csv`
- `data/phone-capture/README.md`
- `data/analysis/dataset-audit.md`
- `apps/web/public/models/`
- `apps/web/src/model/fishStage.ts`
- `apps/web/src/model/mediapipeHeadTailDetector.ts`
- `apps/web/src/hooks/useHeadTailDetection.ts`
- `ml/prepare_stage_capture.py`
- `ml/train_stage_classifier.py`
- [MediaPipe Model Maker](https://ai.google.dev/edge/mediapipe/solutions/model_maker)
