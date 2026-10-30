# スマホ撮影データの収集手順（案）

このテンプレートは、魚の頭・尾の検出だけでなく、「画面外／遮蔽」と「切除済み」を分け、捌き工程を後から評価できる形で記録するためのものです。実際の撮影を始める前に、対象魚とアプリで案内する工程名を決めてください。

## 1. 記録単位

`capture-manifest.csv` は **1行につき1枚の採用フレーム** を記録します。

- `session_id`: 撮影セッション。日付だけでなく、その日の撮影回を識別するID。
- `fish_id`: 同じ魚を工程の最初から最後まで追跡するID。個人名を含めない。
- `frame_id` / `relative_time_ms`: セッション内フレームIDと動画開始からの時刻。
- `frame_path`: リポジトリ外に保管する画像への相対パス。
- `confirmed_stage`: 撮影者が確認した工程。モデルの推測結果とは別の教師ラベル。
- `head_status` / `tail_status`: 部位の状態。映っていないことだけを根拠に切除済みとしない。

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

1. まず、魚種、スマホ機種、カメラ角度、照明、魚を置く場所を記録する。
2. 同じ魚を一つの `fish_id` で追い、工程が変わる前後と作業中から代表フレームを採る。試験では連続動画全体を重複フレームのまま保存せず、キー画像を選ぶ。
3. 手・包丁・水滴・反射・重なり・画面端など、現場の難しい条件も含める。見やすい正面画像だけに偏らせない。
4. 工程は撮影者が目視して確定する。アプリの「次の状態へ」操作時刻が取れる場合は、フレーム時刻と合わせて保存する。
5. 学習・検証・テストはフレームをランダムに割らず、`fish_id` と `session_id` をまたがない単位で分ける。同じ魚の隣接フレームが別セットに入ると評価が楽観的になる。
6. 画像は人物の顔や不要な個人情報が入らないようにし、他人が映るときは撮影前に同意を取る。配布前にはEXIFなどの位置・端末情報を取り除く。

## 4. CSV値の例

`capture-manifest.csv` は列名だけの空テンプレートです。例は実データと混同しないようここに示します。

```csv
session_id,fish_id,frame_id,relative_time_ms,frame_path,confirmed_stage,head_status,tail_status,hands_visible,knife_visible,occlusion,device_model,camera_view,lighting,review_status,notes
pilot-2026-10-29-a,fish-001,frame-0001,0,images/pilot-2026-10-29-a/fish-001-0001.jpg,whole,present_visible,present_visible,true,false,none,phone-model,overhead,indoor-led,reviewed,試し撮りの例
```

例の行は説明用で、実際に撮影したデータではありません。
