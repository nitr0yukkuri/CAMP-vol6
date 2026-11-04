# 人手確認済みデータの準備

この手順では、端末で撮影した画像と人手ラベルから、MediaPipe Model Maker向けの学習データを作ります。画像・個人情報を含みうるCSVはリポジトリに入れず、公開アプリにも研究用の撮影画面はありません。収集と確認は、同意を得たうえで手元の管理下で行ってください。

## 1. CSVと画像

1行に1枚の画像を記録します。空の列見本はこのフォルダーの [capture-manifest.csv](./capture-manifest.csv) です。画像はCSVと同じフォルダー、またはその配下に置き、frame_pathはCSVからの相対パスにします。

- image_class: 魚の画像はfish、魚が写っていない画像はnon_fish。列がない古いCSVはfishとして扱います。
- fish_id / session_id: 同じ魚、同じ人物や撮影対象、同じ撮影回の画像を同じ分割にまとめるための匿名IDです。氏名や連絡先を含めないでください。
- review_status: 人が画像とラベルを照合した行だけreviewedにします。
- head_status / tail_status: 魚画像の状態。見えないことだけを理由にremoved_confirmedにせず、判断できない場合はunknownを使います。
- head_bbox_* / tail_bbox_*: 見えている頭・尾を画像上で人が囲んだ正規化座標です。AI候補をそのまま正解ラベルにしません。
- confirmed_stage: 工程分類用の人手ラベルです。画像から分からない場合はunknownにします。
- capture_source: 時系列に撮影した画像はcamera_sequence、単独の持ち込み画像はstatic_image。省略時はcamera_sequenceです。
- relative_time_ms: 時系列画像では撮影開始からの経過時間、単独画像では0にします。

人物が写る画像を使う場合は本人の明示同意を得てください。顔画像を含む研究用データは手元に留め、Gemini APIやGitHubへ送らないでください。画像を第三者へ共有する前に同意範囲を確認します。

## 2. 頭・尾検出の負例を準備

魚が写っていない画像に誤った頭・尾が出るかを測るため、背景、人物、調理道具などの画像を人が確認して記録します。魚が一部でも写る画像はnon_fishにせず、魚の画像として扱ってください。

non_fish行は次の形にします。

- image_class=non_fish、review_status=reviewed
- head_statusとtail_statusは空欄またはunknown
- 頭・尾の枠の座標と*_bbox_source=manualは空欄
- 同じ人物・背景・撮影回を分割間で共有しない匿名fish_idとsession_id

魚画像では頭と尾の両クラスについて、人が確認した正例を作ります。負例を1枚でも含める場合は、train・validation・testのすべてに独立した負例グループが必要です。各splitには魚の頭・尾の正例も必要です。

まず魚ID・撮影回でグループ分割のひな形を作ります。

~~~powershell
python ml/prepare_phone_capture.py --manifest "D:\fish-pilot\capture-manifest.csv" --images-dir "D:\fish-pilot" --output ml/generated/phone-capture/split-plan --write-split-template
~~~

group-split-template.csvの各グループを、漏洩がないようtrain・validation・testへ割り当てます。同じ魚IDまたは撮影セッションIDを共有する行は必ず同じsplitにします。負例の同じ人物や撮影環境もtrainとtestにまたがらないようにしてください。独立グループが3つ未満なら、held-out testとしての評価はできません。

~~~powershell
python ml/prepare_phone_capture.py --manifest "D:\fish-pilot\capture-manifest.csv" --images-dir "D:\fish-pilot" --output ml/generated/phone-capture/converted --split-map ml/generated/phone-capture/split-plan/group-split-template.csv
~~~

変換後、ml/generated/phone-capture/converted/coco/にCOCO形式のデータができます。COCO注釈なし画像はModel Makerで除外されるため、変換器は人が確認したnon_fish画像に画像全体の専用クラス注釈を付けます。出力は魚画像と負例画像を区別した集計を含みます。既存の生成先を置き換えるときだけ--forceを付けてください。

## 3. 学習・評価

この変換器はデータを用意するだけで、モデルを公開・配布しません。MediaPipe Model Makerで学習する手順と環境は[ML手順](../../ml/README.md)を参照してください。評価では魚なし画像に頭・尾が誤検出された割合と、負例クラスの検知率を見ます。同時に、魚画像を負例クラスが誤って抑止する割合も確認します。

固定しきい値は初期の比較用です。実機・独立セッションのデータで、負例検知と魚の見逃しを一緒に評価してからモデル採用を判断してください。顔検出と負例学習を併用しても、未見の顔や撮影条件への誤検知・見逃しを保証なくゼロにはできません。

## 4. 工程分類モデルは別の評価対象

頭・尾検出器と工程分類器は別のモデルです。工程画像は魚種別に準備し、5つの既知状態（whole、head_removed、gutted、filleting、finished）を人が確認します。現行の工程データ準備ではother、unknown、未確認行は学習から除外します。工程の時間変化を評価する場合はcamera_sequenceだけを使い、単独画像のstatic_imageは遷移評価から除外します。

工程用データの分割・学習・評価コマンドは[ML手順](../../ml/README.md#train-a-fish-specific-stage-classifier)を参照してください。
サーモンの初回パイロットでは、同じ種類のサーモンだけを対象にし、次のラベルを画像ごとに人が確認してください。

- `whole`: 頭が付いた状態。うろこを取ったかどうかは分けません。
- `head_removed`: 頭を外し、腹はまだ開いていない状態。
- `gutted`: 腹を開き、内臓を外した状態。
- `filleting`: 片側または反対側の身を中骨から外している途中。
- `finished`: 両側の身が中骨から分かれた状態。骨・皮を残すかは分類しません。
- `unknown`: 画像から工程を確定できない場合。AIの予測を正解ラベルにしません。

うろこ処理、骨抜き、皮の要否は現在の5工程ラベルで判別できません。これらを自動判定する教師ラベルとして混ぜないでください。撮影はiPhone 15など実際に使う端末で、複数の魚と別々の撮影回から行います。連続フレームの見た目だけで分割せず、同じ魚や撮影回はtrain・validation・testのどれか1つにまとめます。工程を正しく確認できる経験者の確認が得られるまでは、包丁作業を含む画像に推定ラベルを付けて学習へ進めません。

工程用データの分割・学習・評価コマンドは[ML手順](../../ml/README.md#train-a-fish-specific-stage-classifier)を参照してください。`--fish-id salmon` を指定してサーモン用のデータを準備できます。`100枚/クラス`は初期収集の目安に過ぎず、同じ魚の連続画像だけで枚数を満たさないでください。`salmon`モデルを公開アプリへ配置する前に、独立した魚・撮影回のtest評価とiPhone上の読み込み確認が必要です。
