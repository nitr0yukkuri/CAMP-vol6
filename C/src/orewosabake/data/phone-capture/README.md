# スマホ撮影データの収集手順（案）

このテンプレートは、魚の頭・尾の検出だけでなく、「画面外／遮蔽」と「切除済み」を分け、捌き工程を後から評価できる形で記録するためのものです。実際の撮影を始める前に、対象魚とアプリで案内する工程名を決めてください。

## 1. 記録単位

`capture-manifest.csv` は **1行につき1枚の採用フレーム** を記録します。アプリの魚選択画面から「研究用データを撮る」を選び、カメラを起動すると、AIが検出した頭・尾だけ「見える」を仮入力します。工程・手・包丁・遮蔽・撮影条件など、AIが判断できない項目は`unknown`（不明）から始まります。撮影後、静止画上で頭と尾を人が別々に囲みます。AIの枠は教師ラベルへコピーしません。ラベル確認後に画像（長辺832px以下のJPEG）を個別にブラウザーへダウンロードし、CSVは「CSVラベル一覧を保存」から出力します。画像とラベルをAPIへ送信しません。

スマートフォンで実際に使うにはHTTPSで配信されたURLが必要です。`http://127.0.0.1:5173`は開発PC内だけのアドレスで、スマートフォンからはそのPCを指しません。カメラAPIはHTTPSまたは同じ端末のlocalhostでのみ利用できます。

リポジトリ内に撮影データを置く場合、画像・動画と`*_capture-manifest.csv`のセッション出力は`.gitignore`で除外されます。空の`capture-manifest.csv`テンプレートとこの手順書は追跡対象です。

人が選ぶ工程・頭尾の状態は**画像単位ラベル**です。`ai_observation_json`にはモデルが出した検出枠が記録されますが、これは未確認のAI候補で、人手で確認した教師ラベルではありません。物体検出器の学習・評価に使う場合は、候補を人が確認・修正してから教師データとして扱ってください（[学習手順](../../ml/README.md)）。

- `fish_species`: アプリで選択した魚種名。
- `session_id`: 撮影セッション。日付だけでなく、その日の撮影回を識別するID。
- `fish_id`: 同じ魚を工程の最初から最後まで追跡するID。個人名を含めない。
- `frame_id`: セッション内で連番になる静止画ID。
- `relative_time_ms`: 撮影画面でカメラを最初に起動してからの経過時間。動画や魚をさばき始めた時刻ではない。
- `frame_path`: リポジトリ外に保管する画像への相対パス。
- `confirmed_stage`: 撮影者が確認した工程。モデルの推測結果とは別の教師ラベル。
- `head_status` / `tail_status`: 部位の状態。AIが検出した場合だけ`present_visible`を仮入力する。検出なしは`unknown`のまま。映っていないことだけを根拠に切除済みとしない。
- `head_status_source` / `tail_status_source`: `ai_suggestion`, `manual`, `unknown`のいずれか。AI仮入力と人の入力を区別する。
- `review_status`: 撮影時点でラベルを見直したか。未チェックは`needs_review`。
- `ai_status` / `ai_observation_json`: 撮影時点のAI処理状態と検出候補（信頼度・正規化バウンディングボックスを含む）。検出が空でも、頭・尾がないことを示すわけではない。人が選んだ状態とは別の情報。
- `head_bbox_*` / `tail_bbox_*`: 静止画上で人が描いた正規化枠（左上の`x`,`y`と`width`,`height`）。`*_bbox_source=manual`だけが人手枠。AI候補とは別列。
- `hands_visible` / `knife_visible`: `true`, `false`, `unknown`のいずれか。初期値は`unknown`。
- `occlusion`: `unknown`, `none`, `hands`, `knife`, `container`, `overlap`, `other`のいずれか。
- `camera_view`: `unknown`, `overhead`, `oblique`, `side`, `other`のいずれか。
- `lighting`: `unknown`, `daylight`, `indoor-led`, `dim`, `other`のいずれか。
- `device_model`: 撮影者が任意に入力する端末機種。未入力は`unknown`。ブラウザーから正確な端末型番は推測しない。
- `notes`: 任意の短い補足。個人情報は書かない。

## 2. 固定するラベル値

まずは以下を使い、クラスを増やす前に数十枚の試し撮りで意味が重ならないことを確認します。

`confirmed_stage` の初期案:

- `whole`: 頭・尾が付いた未処理
- `head_removed`: 頭を外したことを撮影者が確認
- `gutted`: 内臓処理を終えたことを撮影者が確認
- `filleting`: 三枚おろしなど、身を骨から分けている途中
- `finished`: 対象の捌き工程を終えた
- `other` / `unknown`: 上記に当てはまらない／判断できない

`head_status` と `tail_status` の値:

- `present_visible`: 付いており、画面で確認できる
- `removed_confirmed`: 撮影者が切除済みと確認した
- `occluded`: 手・包丁・容器などの背後に隠れている
- `out_of_frame`: カメラ画角の外にある
- `unknown`: 状態を確定できない

画面に頭がない場合、`removed_confirmed` ではなく、判断根拠に応じて `occluded` / `out_of_frame` / `unknown` を付けます。

## 3. 撮影の進め方

1. 魚種を選んで「研究用データを撮る」を開き、カメラ枠の「カメラを起動」を押す。まずスマホ機種、カメラ角度、照明、魚を置く場所を記録する。
2. 同じ魚を一つの `fish_id` で追い、工程が変わる前後と作業中から代表フレームを採る。試験では連続動画全体を重複フレームのまま保存せず、キー画像を選ぶ。
3. 手・包丁・水滴・反射・重なり・画面端など、現場の難しい条件も含める。見やすい正面画像だけに偏らせない。
4. AIの枠は候補として扱う。撮影した静止画で頭と尾をそれぞれ囲み、該当部位が見えないと判断したら枠を付けず、状態を「遮蔽・画角外・未確認」などにします。工程やAI対象外の項目も人が選びます。確認チェックを付けたときだけ状態を人手確認済みとして記録します。検出がないだけで`removed_confirmed`にしません。AI提案と人手枠はCSVの別列に保存されます。
5. 学習・検証・テストはフレームをランダムに割らず、`fish_id` と `session_id` をまたがない単位で分ける。同じ魚の隣接フレームが別セットに入ると評価が楽観的になる。
6. 画像は人物の顔や不要な個人情報が入らないようにし、他人が映るときは撮影前に同意を取る。ブラウザーのCanvasからJPEGを生成するため元画像のEXIFは引き継がれないが、配布前には画像とメモを再確認する。
7. 撮影画像とCSVを同じフォルダーにまとめる。CSVの`frame_path`は画像ファイル名です。手動枠と状態が確認できた行だけを学習準備に使います。

タブを更新・終了するとCSV行は失われます。撮影後はCSVを保存してからタブを閉じてください。アプリは保存忘れ防止のブラウザー警告を出します。

## 4. 撮影・確認

実端末を使う前に [端末スモークチェック](device-smoke-check.md) を記録します。撮影後の枠付けで指を離した位置と枠がずれる場合、画面回転後に映像が切れる場合、画像またはCSVの保存先が分かりにくい場合は、先にその不具合を記録して直します。人物が映る映像や魚の捌き作業を、研究用の同意なしに第三者へ共有しないでください。

## 5. 魚・撮影回で分けた学習データを準備

撮影CSVとJPEGはリポジトリ外にまとめます。まずグループ一覧を生成します。

```powershell
python ml/prepare_phone_capture.py `
  --manifest "D:\fish-pilot\capture-manifest.csv" `
  --images-dir "D:\fish-pilot" `
  --output ml/generated/phone-capture/split-plan `
  --write-split-template
```

`ml/generated/phone-capture/split-plan/group-split-template.csv` の`split`列へ、各独立グループを`train`、`validation`、`test`のいずれかに割り当てます。魚IDまたは撮影セッションIDを共有する行は同じ連結グループになり、別splitには分けられません。同じ個体を別の日に撮った場合も同じグループにまとまります。独立グループが3つ未満なら、漏洩のない3分割テストはできません。データを集めるまで評価を保留してください。

```powershell
python ml/prepare_phone_capture.py `
  --manifest "D:\fish-pilot\capture-manifest.csv" `
  --images-dir "D:\fish-pilot" `
  --output ml/generated/phone-capture/converted `
  --split-map ml/generated/phone-capture/split-plan/group-split-template.csv
```

変換器は、`reviewed`かつ人が確認した頭・尾の状態、手描き枠を持つ画像だけを採用します。`unknown`、遮蔽、画角外、AI提案のみの枠は除外します。学習用に割り当てた画像には頭と尾のどちらかの人手枠が必要です。各splitに両クラスの正例が揃わない場合は評価データを作りません。COCO形式の出力は無視対象の`ml/generated/phone-capture/converted/coco/`に作成され、既存出力を置換する場合だけ`--force`が必要です。レポートには行数・除外理由・クラス数が出ますが、備考や生のラベル値は含めません。

この変換はCOCOデータを準備する段階までです。既存のMendeley学習結果へスマホ画像を自動で混ぜたり、電話端末で再学習したりはしません。人手データで学習・閾値調整した後は、同じ独立したtestグループで再評価し、スマホ条件ごとに失敗を確認します。

## 6. CSV値の例

`capture-manifest.csv` は列名だけの空テンプレートです。例は実データと混同しないようここに示します。

```csv
fish_species,session_id,fish_id,frame_id,relative_time_ms,frame_path,confirmed_stage,head_status,head_status_source,tail_status,tail_status_source,hands_visible,knife_visible,occlusion,device_model,camera_view,lighting,review_status,notes,ai_status,ai_observation_json,head_bbox_x,head_bbox_y,head_bbox_width,head_bbox_height,head_bbox_source,tail_bbox_x,tail_bbox_y,tail_bbox_width,tail_bbox_height,tail_bbox_source
アジ,pilot-example-a,fish-001,frame-0001,0,pilot-example-a_fish-001_frame-0001.jpg,whole,present_visible,manual,present_visible,manual,unknown,unknown,unknown,unknown,unknown,unknown,reviewed,説明用のみ,active,"",0.1,0.2,0.2,0.3,manual,0.7,0.4,0.1,0.2,manual
```

例の行は説明用で、実際に撮影したデータではありません。撮影した画像・映像は追跡しないでください。
