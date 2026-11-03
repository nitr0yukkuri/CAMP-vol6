# 研究用データ収集・適合性分析

調査記録: 2026-11-02〜2026-11-03  
現行実装の参照点: GitHub `main` at `a73e49a9a0a9516e4ca593380d16076553356930`

## 結論

手元にある公開画像320枚は、魚の頭・尾位置または魚体領域を扱うサンプルで、魚をさばく工程の教師ラベルはない。スマホ工程撮影マニフェストも空。したがって、現状のデータで工程分類の学習・評価を行ったとは言えない。まずは人が工程を確認したスマホ撮影を、魚個体・撮影セッション単位で集める必要がある。

元画像はリポジトリのGit追跡外に置いている。ここに書いた画像数・容量は調査時点のローカル取得分であり、PRに画像を同梱していない。

## 手元の公開データ

| データ | 取得・注釈 | 妥当な用途 | 工程判定には使えない理由 |
| --- | --- | --- | --- |
| Mendeley head/tail | 200画像。head / tailのYOLO矩形。配布アーカイブ13,476,057 bytes。CC BY 4.0表示 | 頭・尾の位置検出の基準・学習用 | 作業の工程ラベルがない |
| AutoFish | group 09/24から120画像。905,500,452 bytes。38個体、1,520マスク。CC BY 4.0表示 | 魚体領域・個体IDのデータ構造調査 | コンベアの俯瞰画像で、作業者・包丁・工程変化がない |
| スマホ工程撮影 | 0行 | 次に集める実利用条件の教師データ | 実写の工程ラベル自体がまだない |

合計の公開画像は320枚（Mendeley 200 + AutoFish 120）。AutoFishの120枚は全量約15.9 GBのうち、2グループのみを選んだ。両グループで38個体、個体IDの重なりはなかった。全画像は2464×2056。配布COCO JSONとmetadata CSVは18,158マスクで一致し、データカード・論文の18,160という説明とは2マスク差があった。カテゴリ数にも説明との差があるため、今回の小標本では元ラベルを統合していない。全量を使うなら画像ID・カテゴリID・魚ID・マスクをあらためて監査する。

公開素材は `data/.gitignore` によってGitへ含めない。入手元・版・ライセンス表記は[`data/raw/README.md`](../raw/README.md)に記録する。

## 既存の頭・尾検出結果の読み方

手元の既存metricsでは、Mendeleyの静止画ホールドアウト26枚に対するbaseline macro F1は0.8002（head F1 0.8718、tail F1 0.7287、threshold 0.35）。別candidateのmacro F1は0.8129だが、testラベルのSHA-256がbaselineと異なり、同じ正解ラベルでの比較ではない。優劣の結論は出せない。

26枚は1撮影日の画像で、魚個体・調理台・端末・遮蔽条件の独立性を十分に示さない。数値をスマホの調理中映像、顔や魚の写っていない映像、工程分類の精度として扱わない。詳細条件は[`ml/README.md`](../../ml/README.md)と生成metricsを参照する。

MediaPipeは端末内でTFLiteモデルを実行するランタイムであり、モデルの学習ラベル以上の意味を推論しない。head/tail検出モデルをMediaPipeで動かしても、`whole`・`head_removed`等の工程分類モデルにはならない。魚の状態、頭尾の見える状態、作業動作は異なるタスクとして扱う。

## 公開候補の適合性

- [AutoFish](https://huggingface.co/datasets/vapaau/autofish): 魚体セグメンテーションや個体の構造調査に使えるが、家庭の調理台での工程認識とは撮影条件が大きく異なる。
- [DeepFish2](https://zenodo.org/records/7108754): 魚市場のトレー画像。魚体・魚種検出には参考になるが、捌き作業の時系列ではない。調査時のAPI metadataでは約988.5 MB・4,471ファイル。今回の画像は取得していない。
- [FishCut](https://huggingface.co/datasets/salahkhenfer/FishCut): 頭を落としたヘイクの切断位置推定。工場内の切断線タスクであり、工程分類に直接転用できない。CC BY-NC 4.0表示なので商用利用にも制約がある。
- [FishNet](https://www.fishnet.ai/description): 船上の魚・人・道具検出。ラベル目的、背景、撮影視点が家庭調理と異なる。ライセンス条件も用途前に確認する。
- [ChangeIt](https://github.com/soCzech/ChangeIt) と [VidOSC](https://github.com/facebookresearch/VidOSC): 動画内の作業・時間区間を検討する資料にはなる。元動画の権利、魚個体の工程ラベル、対象状態は別途確認が必要。
- [YouCook2](https://youcook2.eecs.umich.edu/): 一般調理の手順区間を含むが、丸魚の捌き工程専用ではない。配布は注釈であり、元動画そのものの利用条件を確認する。
- [LaksData](https://pmc.ncbi.nlm.nih.gov/articles/PMC13112392/): 加工後サーモンフィレの品質・マルチモーダルデータ。丸魚の工程遷移とは目的が異なる。
- [DaFiF](https://data.mendeley.com/datasets/vx4ptwk3pb/1): 魚の鮮度を扱い、下処理工程のラベルではない。
- [Wikimedia Commonsの魚のうろこ取りカテゴリ](https://commons.wikimedia.org/wiki/Category:Scaling_fish)など: 検索結果数は正解ラベル数ではない。素材ごとに内容、権利、撮影回、重複を確認する。

### 動画・教材の扱い

調査時に確認できたCommons動画は、うろこ取り2本（約20.4秒、4.9秒）とフィレ作業1本（約29秒）。投稿者や作業の種類に偏りがあり、5状態の工程を独立した魚・撮影回で評価できる分量ではない。静止画候補にも料理、看板、図記号、同じ場面の連写などが混じる。検索だけでラベルを自動付与しない。

ZPEの教材「Initial processing of fish」は魚の初期処理を説明し、ページ上にCC0表記がある。ただし教材内の1つの映像だけでは、多数の魚個体・スマホ撮影条件を含む独立テストセットにならない。学習データに含める前に映像内容と利用条件を確認する。

## 収集・分割の方針

1. 対象魚を最初は1種に絞る。魚種間で見え方が異なるため、モデルの一般化を仮定しない。
2. `confirmed_stage` は撮影者が実作業を確認して入力する。AI推定を教師ラベルに転記しない。
3. `head_status` / `tail_status` は `present_visible`、`removed_confirmed`、`occluded`、`out_of_frame`、`unknown`を区別する。画面から消えただけで切除済みとは判断しない。
4. 同じ魚と撮影セッションをtrain / validation / test間で分離する。隣接フレームや背景差し替え画像は独立個体として数えない。
5. 顔、個人情報、他人の映り込みを確認し、同意・端末内保管・共有条件を決める。研究撮影の画像とCSVは利用者が端末へ保存し、Gitには含めない。
6. 工程分類の画像評価と、工程変化の時系列評価を分ける。工程変化を主張するには時刻付き系列で誤提案、見逃し、遅延も評価する。

学習手順は[`phone-capture/README.md`](../phone-capture/README.md)、モデル評価の制約は[`data/analysis/stage-model-readiness-20261103.md`](./stage-model-readiness-20261103.md)に記録する。

## Geminiの旧pilotと現行API

2026-11-02に記録したGeminiの疎通試行は、合成画像5枚を旧ルート `/api/ai/observe` へ送る歴史的な検証で、実写精度評価ではない。当時のメモには2/5件完了、完了2件中の一致2件、再試行時のタイムアウトと上流503が記録されている。試行結果CSVは `ml/generated/` のGit無視対象にあり、このPRには添付していないため、記録値をここから再現検証できない。5枚だけの結果を精度として解釈しない。

現行mainのAPIは `POST /api/guide/analyze`、既定モデル名は `gemini-3.5-flash-lite`。旧ルート・旧モデル・旧タイムアウト設定を現在の動作として参照しない。Gemini上流の一時エラーはWorkerで限定再試行する。テスト専用のfake APIを使ったローカル検証であり、実Google APIや本番Workerへの負荷試験はしていない。

## 収集物・参照元

- 元画像・アーカイブ: `data/raw/`（Git追跡外）
- AutoFishサンプル: `data/raw/autofish-preview/group_09/`、`group_24/`
- 撮影手順: [`phone-capture/README.md`](../phone-capture/README.md)
- 空テンプレート: [`phone-capture/capture-manifest.csv`](../phone-capture/capture-manifest.csv)
- 現行モデル監査: [`dataset-audit.md`](./dataset-audit.md)、[`ml/README.md`](../../ml/README.md)
- [Mendeley Data: head and tail of fish](https://data.mendeley.com/datasets/7m2yzmpcft/1)
- [AutoFish dataset card](https://huggingface.co/datasets/vapaau/autofish) / [WACV 2025 workshop paper](https://openaccess.thecvf.com/content/WACV2025W/MaCVi/papers/Bengtson_AutoFish_Dataset_and_Benchmark_for_Fine-grained_Analysis_of_Fish_WACVW_2025_paper.pdf)
- [FishNet terms](https://www.fishnet.ai/download) / [FishCut dataset](https://huggingface.co/datasets/salahkhenfer/FishCut)
- [YouCook2 downloads and terms](https://youcook2.eecs.umich.edu/download)
- [MediaPipe Model Maker](https://ai.google.dev/edge/mediapipe/solutions/model_maker)
