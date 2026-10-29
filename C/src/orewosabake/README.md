# 俺をさばけ — AI試作

`C/src/orewosabake` 内だけで作業する、頭・尾検出の学習準備とUIモックです。魚捌き工程を認識するモデルはまだありません。

## UIモックを起動

Node.js 22.12以上が必要です。

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

画面は `http://127.0.0.1:5173` です。カメラ権限を要求せず、魚のシルエット・検出枠・スコアをサンプル表示します。検出器の値が工程を進めることはありません。

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
