import { useEffect, useState } from "react";
import {
  GuideSchema,
  MOCK_GUIDE,
  MOCK_MODEL_STATUS,
  MOCK_OBSERVATION,
  ModelStatusSchema,
  ObservationSchema,
  type Guide,
  type FishState,
  type ModelStatus,
  type Observation,
} from "@orewosabake/contracts";

const fishStateLabels: Record<FishState, string> = {
  whole_fish: "魚全体",
  head_removed: "頭を除去済み",
  opened: "開いた状態",
  filleted: "三枚おろし済み",
  unknown: "工程状態は未判定",
};

async function getJson<T>(path: string, schema: { parse: (value: unknown) => T }, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    throw new Error(`Request failed: ${path} (${response.status})`);
  }
  return schema.parse(await response.json());
}

function FishPlaceholder() {
  return (
    <svg className="fish-placeholder" viewBox="0 0 700 420" role="img" aria-label="魚のシルエット（UIモック用）">
      <defs>
        <linearGradient id="fishBody" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#f1d4a8" />
          <stop offset="0.55" stopColor="#cba77b" />
          <stop offset="1" stopColor="#8b745f" />
        </linearGradient>
        <filter id="fishShadow" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="14" stdDeviation="12" floodColor="#0b2832" floodOpacity="0.22" />
        </filter>
      </defs>
      <ellipse cx="352" cy="222" rx="247" ry="112" fill="url(#fishBody)" filter="url(#fishShadow)" />
      <path d="M565 222 679 143 679 301Z" fill="#b28e69" />
      <path d="M345 111 421 57 456 128Z" fill="#a88968" />
      <path d="M336 331 424 375 463 322Z" fill="#a88968" />
      <path d="M238 201 174 135 255 171Z" fill="#9f8265" />
      <path d="M235 244 164 291 260 274Z" fill="#9f8265" />
      <path d="M283 206c66-46 143-49 211-16" fill="none" stroke="#f8e7c8" strokeOpacity=".58" strokeWidth="5" />
      <path d="M279 232c76 25 141 25 203 3" fill="none" stroke="#725f51" strokeOpacity=".42" strokeWidth="4" />
      <circle cx="185" cy="203" r="11" fill="#f8f4eb" />
      <circle cx="187" cy="203" r="6" fill="#203b41" />
      <circle cx="188" cy="202" r="2" fill="#fff" />
      <path d="M105 225q23 17 48 3" fill="none" stroke="#655346" strokeWidth="4" strokeLinecap="round" />
      <g fill="none" stroke="#f8e8ca" strokeOpacity=".34" strokeWidth="2">
        <path d="M288 166q8 56 0 112" />
        <path d="M330 145q9 75 0 150" />
        <path d="M373 132q10 88 0 176" />
        <path d="M416 133q10 88 0 176" />
        <path d="M459 147q9 75 0 150" />
        <path d="M502 169q8 56 0 112" />
      </g>
    </svg>
  );
}

function DetectionBoxes({ observation }: { observation: Observation }) {
  return (
    <div className="detection-layer" aria-label="頭と尾の模擬検出位置">
      {observation.detections.map((detection) => (
        <div
          className={`detection-box detection-box--${detection.label}`}
          key={detection.label}
          style={{
            left: `${detection.box.x * 100}%`,
            top: `${detection.box.y * 100}%`,
            width: `${detection.box.width * 100}%`,
            height: `${detection.box.height * 100}%`,
          }}
        >
          <span>{detection.label === "head" ? "頭" : "尾"} · {(detection.score * 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [guide, setGuide] = useState<Guide>(MOCK_GUIDE);
  const [modelStatus, setModelStatus] = useState<ModelStatus>(MOCK_MODEL_STATUS);
  const [observation, setObservation] = useState<Observation>(MOCK_OBSERVATION);
  const [activeStep, setActiveStep] = useState(0);
  const [apiConnected, setApiConnected] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const loadMockData = async () => {
      try {
        const [nextGuide, nextStatus, nextObservation] = await Promise.all([
          getJson("/api/guide", GuideSchema, controller.signal),
          getJson("/api/model/status", ModelStatusSchema, controller.signal),
          getJson("/api/model/mock-observation", ObservationSchema, controller.signal),
        ]);
        if (!controller.signal.aborted) {
          setGuide(nextGuide);
          setModelStatus(nextStatus);
          setObservation(nextObservation);
          setApiConnected(true);
        }
      } catch {
        if (!controller.signal.aborted) {
          setApiConnected(false);
        }
      }
    };

    void loadMockData();
    return () => controller.abort();
  }, []);

  const currentStep = guide.steps[activeStep];
  const canGoBack = activeStep > 0;
  const canGoForward = activeStep < guide.steps.length - 1;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="俺をさばけ ホーム">
          <span className="brand-mark" aria-hidden="true">魚</span>
          <span><strong>俺をさばけ</strong><small>FISH PREP GUIDE</small></span>
        </a>
        <div className="topbar-meta">
          <span className="mock-pill"><i />UI MOCK</span>
          <span className="local-pill"><i />映像は端末内処理の設計</span>
        </div>
      </header>

      <section className="intro" id="top">
        <div>
          <p className="eyebrow">REAL-TIME FISH PREPARATION</p>
          <h1>魚の様子を見ながら、<br className="mobile-break" />自分のペースで。</h1>
          <p className="intro-copy">カメラ映像と認識結果を並べて確認する画面のモックです。工程を進める操作は、いつもあなたが行います。</p>
        </div>
        <div className="session-tag"><span className="session-dot" />試作セッション <b>01</b></div>
      </section>

      <div className="mock-notice" role="status">
        <span className="notice-symbol" aria-hidden="true">!</span>
        <div><strong>表示されている検出枠・スコアはすべてサンプル値です。</strong><span>学習済みモデルもカメラ接続もまだありません。</span></div>
        <span className="api-indicator">{apiConnected ? "API モック接続" : "ローカル表示"}</span>
      </div>

      <section className="workspace" aria-label="魚の状態ガイド モック">
        <div className="preview-panel panel">
          <div className="panel-heading">
            <div><span className="section-kicker">LIVE VIEW</span><h2>カメラプレビュー</h2></div>
            <span className="preview-state"><i />映像モック</span>
          </div>

          <div className="preview-stage">
            <div className="stage-grid" aria-hidden="true" />
            <div className="stage-topline"><span>PREVIEW · SAMPLE</span><span>1280 × 720</span></div>
            <FishPlaceholder />
            <DetectionBoxes observation={observation} />
            <span className="corner corner--tl" aria-hidden="true" />
            <span className="corner corner--tr" aria-hidden="true" />
            <span className="corner corner--bl" aria-hidden="true" />
            <span className="corner corner--br" aria-hidden="true" />
            <div className="stage-bottomline"><span><i />カメラ未接続</span><span>推論頻度の想定 · 1〜2回/秒</span></div>
          </div>

          <div className="preview-footer">
            <div className="privacy-note"><span aria-hidden="true">◉</span><p><strong>映像を送信・保存しません</strong><small>本番時も端末内での推論を想定した設計です。</small></p></div>
            <button className="camera-button" type="button" disabled title="カメラ連携はまだありません"><span aria-hidden="true">＋</span> カメラ連携は未実装</button>
          </div>
        </div>

        <aside className="guide-column">
          <section className="step-panel panel">
            <div className="panel-heading">
              <div><span className="section-kicker">YOUR GUIDE</span><h2>進行中の工程</h2></div>
              <span className="step-counter">{String(activeStep + 1).padStart(2, "0")} <i>/</i> {String(guide.steps.length).padStart(2, "0")}</span>
            </div>

            <div className="step-progress" aria-label={`全${guide.steps.length}工程中${activeStep + 1}工程目`}>
              {guide.steps.map((step, index) => (
                <span key={step.id} className={index <= activeStep ? "progress-segment is-active" : "progress-segment"} />
              ))}
            </div>

            {currentStep ? (
              <div className="current-step" aria-live="polite">
                <span className="step-number">STEP {String(activeStep + 1).padStart(2, "0")}</span>
                <h3>{currentStep.title}</h3>
                <p>{currentStep.description}</p>
                <div className="expected-state"><span>工程状態（参考）</span><code>{fishStateLabels[currentStep.expectedState]}</code></div>
              </div>
            ) : null}

            <div className="step-list" aria-label="工程一覧">
              {guide.steps.map((step, index) => (
                <button
                  className={`step-row${index === activeStep ? " is-current" : ""}${index < activeStep ? " is-done" : ""}`}
                  key={step.id}
                  onClick={() => setActiveStep(index)}
                  type="button"
                  aria-current={index === activeStep ? "step" : undefined}
                >
                  <span className="step-row-index">{index < activeStep ? "✓" : String(index + 1).padStart(2, "0")}</span>
                  <span>{step.title}</span>
                  <span className="step-chevron" aria-hidden="true">›</span>
                </button>
              ))}
            </div>

            <div className="step-controls">
              <button className="back-button" disabled={!canGoBack} onClick={() => setActiveStep((step) => Math.max(0, step - 1))} type="button">戻る</button>
              <button className="next-button" disabled={!canGoForward} onClick={() => setActiveStep((step) => Math.min(guide.steps.length - 1, step + 1))} type="button">次の工程へ <span aria-hidden="true">→</span></button>
            </div>
            <p className="manual-note">認識結果で工程は自動的に切り替わりません。</p>
          </section>

          <section className="model-panel panel">
            <div className="panel-heading model-heading">
              <div><span className="section-kicker">MODEL OBSERVATION</span><h2>モデルの観察結果</h2></div>
              <span className="model-state"><i />{modelStatus.status === "ready" ? "接続済み" : "未学習"}</span>
            </div>
            <p className="model-summary">Mendeleyの公開データで試せるのは、魚の「頭」「尾」の位置検出です。</p>
            <div className="detection-list">
              {observation.detections.map((detection) => (
                <div className="detection-row" key={detection.label}>
                  <span className={`part-icon part-icon--${detection.label}`} aria-hidden="true">{detection.label === "head" ? "頭" : "尾"}</span>
                  <span className="part-name">{detection.label === "head" ? "頭" : "尾"}<small>位置検出 · 模擬</small></span>
                  <span className="part-score">{Math.round(detection.score * 100)}<small>%</small></span>
                </div>
              ))}
            </div>
            <div className="state-warning"><span aria-hidden="true">↗</span><p><strong>捌き工程の認識は未学習</strong><small>頭が画面にないだけでは、切除済みか画面外かを区別できません。</small></p></div>
            <div className="model-footnote"><span>{modelStatus.runtime.replaceAll("_", " ")}</span><span>{observation.source === "mock" ? "SAMPLE DATA" : "ON-DEVICE"}</span></div>
          </section>
        </aside>
      </section>

      <footer className="footer-note"><span>OREWOSABAKE · PROTOTYPE</span><span>認識は参考表示です。安全や工程完了を保証するものではありません。</span></footer>
    </main>
  );
}

export default App;
