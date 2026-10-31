import { useEffect, useMemo, useRef, useState } from "react";
import { AdvanceGuideStepRequestSchema, GuideContextRequestSchema, GuideRequestSchema, GuideSessionSchema, MOCK_GUIDE, type FishCategory, type Guide, type GuideContextRequest, type GuideRequest, type GuideSession, type Observation } from "@orewosabake/contracts";
import { useHeadTailDetection } from "./hooks/useHeadTailDetection";

type Category = "よく使う" | "海水魚" | "淡水魚" | "甲殻類";
type Screen = "select" | "guide";
type CameraStatus = "idle" | "starting" | "active" | "denied" | "unavailable" | "error";

type Fish = {
  name: string;
  category: Exclude<Category, "よく使う">;
  note: string;
  mascot: string;
  searchAliases?: string[];
  popular?: boolean;
};

const categories: Category[] = ["よく使う", "海水魚", "淡水魚", "甲殻類"];
const fishList: Fish[] = [
  { name: "マグロ", category: "海水魚", note: "大型魚 / 海水", mascot: "maguro", popular: true },
  { name: "サーモン", category: "海水魚", note: "切り身でも人気", mascot: "salmon", popular: true },
  { name: "アジ", category: "海水魚", note: "定番 / 海水", mascot: "aji", popular: true },
  { name: "サバ", category: "海水魚", note: "定番 / 海水", mascot: "saba", popular: true },
  { name: "タイ", category: "海水魚", note: "定番 / 海水", mascot: "tai", searchAliases: ["鯛", "たい"] },
  { name: "鮎", category: "淡水魚", note: "定番 / 淡水", mascot: "ayu", searchAliases: ["アユ", "あゆ"] },
  { name: "エビ", category: "甲殻類", note: "下処理ガイド", mascot: "ebi" },
  { name: "カニ", category: "甲殻類", note: "下処理ガイド", mascot: "kani" },
  { name: "イカ", category: "海水魚", note: "海水", mascot: "ika" },
  { name: "タコ", category: "海水魚", note: "海水", mascot: "tako" },
  { name: "はまち", category: "海水魚", note: "海水", mascot: "hamachi", searchAliases: ["ハマチ"] },
  { name: "イワシ", category: "海水魚", note: "海水", mascot: "iwashi" },
  { name: "ぶり", category: "海水魚", note: "海水", mascot: "buri", searchAliases: ["ブリ"] },
  { name: "カツオ", category: "海水魚", note: "海水", mascot: "katsuo" },
  { name: "ヒラメ", category: "海水魚", note: "海水", mascot: "hirame" },
  { name: "カレイ", category: "海水魚", note: "海水", mascot: "karei" },
  { name: "ウナギ", category: "淡水魚", note: "淡水", mascot: "unagi" },
  { name: "アナゴ", category: "海水魚", note: "海水", mascot: "anago" },
  { name: "はも", category: "海水魚", note: "海水", mascot: "hamo", searchAliases: ["ハモ"] },
  { name: "太刀魚", category: "海水魚", note: "海水", mascot: "tachiuo", searchAliases: ["タチウオ"] },
  { name: "カワハギ", category: "海水魚", note: "海水", mascot: "kawahagi" },
];

function fishImage(fish: Fish): string {
  return `/fish-mascots/${fish.mascot}.png`;
}

function fishImageClass(baseClass: string): string {
  return `${baseClass} is-mascot`;
}

async function sendFishContext(requestBody: GuideContextRequest, signal: AbortSignal): Promise<void> {
  const response = await fetch("/api/guide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(GuideContextRequestSchema.parse(requestBody)),
    signal,
  });
  // Valid requests currently return 503 until guide generation is configured.
  if (!response.ok && response.status !== 503) throw new Error("Guide API is unavailable");
}

async function createGuideSession(requestBody: GuideRequest, signal: AbortSignal): Promise<GuideSession> {
  const response = await fetch("/api/guide/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(GuideRequestSchema.parse(requestBody)),
    signal,
  });
  if (!response.ok) throw new Error("Guide session API is unavailable");
  return GuideSessionSchema.parse(await response.json());
}

async function advanceGuideSession(session: GuideSession, signal: AbortSignal): Promise<GuideSession> {
  const currentStep = session.currentStep;
  if (!currentStep) throw new Error("There is no active guide step");

  const response = await fetch(`/api/guide/sessions/${session.sessionId}/advance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(AdvanceGuideStepRequestSchema.parse({ stepId: currentStep.id, source: "button" })),
    signal,
  });
  if (!response.ok) throw new Error("Guide session could not advance");
  return GuideSessionSchema.parse(await response.json());
}

function guideFishId(name: string): GuideRequest["fishId"] | null {
  if (name === "アジ") return "aji";
  if (name === "サバ") return "saba";
  if (name === "タイ") return "tai";
  return null;
}

function toApiFishCategory(category: Fish["category"] | undefined): FishCategory {
  if (category === "海水魚") return "saltwater";
  if (category === "淡水魚") return "freshwater";
  if (category === "甲殻類") return "crustacean";
  return "unknown";
}

function FishMark() {
  return (
    <svg className="fish-mark" viewBox="0 0 170 126" role="img" aria-label="魚のイラスト">
      <path d="M32 63c24-35 78-39 110-4-28 38-82 43-110 4Z" fill="var(--fish-body)" />
      <path d="m135 59 27-22-5 31 6 28-29-24" fill="var(--fish-fin)" />
      <path d="m77 38 15-21 12 26M77 88l17 20 11-27" fill="var(--fish-fin)" stroke="var(--fish-fin)" strokeWidth="5" strokeLinejoin="round" />
      <circle cx="55" cy="55" r="4" fill="var(--deep)" />
      <path d="M40 70q10 6 19 1" fill="none" stroke="var(--fish-detail)" strokeWidth="2" strokeLinecap="round" />
      <path d="M70 50q10 14 0 28m21-32q10 17 0 36m22-32q8 14 0 28" fill="none" stroke="var(--fish-detail)" strokeWidth="2" opacity=".8" />
      <path d="M32 63 12 49l9 18-9 18Z" fill="var(--fish-body)" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.8" cy="10.8" r="5.8" />
      <path d="m15.2 15.2 4.2 4.2" />
    </svg>
  );
}

function CameraPlaceholderIcon() {
  return (
    <svg className="camera-placeholder-icon" viewBox="0 0 80 56" fill="none" aria-hidden="true">
      <path d="M11 15a5 5 0 0 1 5-5h8l4-6h24l4 6h8a5 5 0 0 1 5 5v29a5 5 0 0 1-5 5H16a5 5 0 0 1-5-5V15Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      <circle cx="40" cy="29" r="11" stroke="currentColor" strokeWidth="3" />
    </svg>
  );
}

function RotatePhoneIcon() {
  return (
    <svg viewBox="0 0 150 130" aria-hidden="true">
      <rect x="29" y="14" width="57" height="99" rx="12" fill="none" stroke="currentColor" strokeWidth="4" />
      <path d="M50 25h15" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="M106 42a31 31 0 0 1 8 48m-1-18 1 19 18-4" fill="none" stroke="var(--gold)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>("select");
  const [category, setCategory] = useState<Category>("よく使う");
  const [search, setSearch] = useState("");
  const [selectedFish, setSelectedFish] = useState("アジ");
  const [guide, setGuide] = useState<Guide>(MOCK_GUIDE);
  const [guideSession, setGuideSession] = useState<GuideSession | null>(null);
  const [guideSessionLoading, setGuideSessionLoading] = useState(false);
  const [guideMessage, setGuideMessage] = useState("");
  const [guideAdvancing, setGuideAdvancing] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("idle");
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraMessage, setCameraMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRequestId = useRef(0);
  const guideRequestController = useRef<AbortController | null>(null);
  const guideAdvanceInFlight = useRef(false);
  const headTailDetection = useHeadTailDetection(
    videoRef,
    screen === "guide" && cameraStatus === "active" && cameraStream !== null,
  );

  useEffect(() => () => guideRequestController.current?.abort(), []);

  useEffect(() => {
    if (!cameraStream || !videoRef.current) return;
    videoRef.current.srcObject = cameraStream;
    void videoRef.current.play().catch(() => undefined);
  }, [cameraStream, screen]);

  useEffect(() => () => {
    cameraStream?.getTracks().forEach((track) => track.stop());
  }, [cameraStream]);

  useEffect(() => {
    const videoTrack = cameraStream?.getVideoTracks()[0];
    if (!videoTrack) return;

    const handleTrackEnded = () => {
      cameraRequestId.current += 1;
      setCameraStream(null);
      setCameraStatus("error");
      setCameraMessage("カメラ映像が中断されました。カメラを再起動してください。");
    };

    videoTrack.addEventListener("ended", handleTrackEnded);
    return () => videoTrack.removeEventListener("ended", handleTrackEnded);
  }, [cameraStream]);

  const matchingFish = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return fishList.filter((fish) => {
      const matchesCategory = query.length > 0 || (category === "よく使う" ? fish.popular : fish.category === category);
      const searchTerms = [fish.name, ...(fish.searchAliases ?? [])];
      const matchesSearch = !query || searchTerms.some((term) => term.toLocaleLowerCase().includes(query));
      return matchesCategory && matchesSearch;
    });
  }, [category, search]);

  const chosenFish = selectedFish === "その他" ? search.trim() || "ほかの魚" : selectedFish;
  const selectedFishData = fishList.find((fish) => fish.name === selectedFish);
  const selectedFishVisualData = selectedFishData ?? (selectedFish === "その他" ? fishList.find((fish) => fish.name === "マグロ") : undefined);
  const currentStep = guide.steps[activeStep];
  const fishCanContinue = selectedFish !== "その他" || search.trim().length > 0;

  function startGuide() {
    setScreen("guide");
    setActiveStep(0);
    setGuide(MOCK_GUIDE);
    setGuideSession(null);
    setGuideSessionLoading(false);
    setGuideMessage("");
    setCameraMessage("");

    guideRequestController.current?.abort();
    const guideController = new AbortController();
    guideRequestController.current = guideController;
    const fishContext = {
      fishName: chosenFish,
      fishCategory: toApiFishCategory(selectedFishData?.category),
      fishState: "unknown" as const,
    };
    void sendFishContext(fishContext, guideController.signal).catch(() => {
      // Keep the common manual guide usable when the context endpoint is unavailable.
    });
    const selectedFishId = guideFishId(selectedFish);
    if (selectedFishId) {
      setGuideSessionLoading(true);
      const guideRequest = GuideRequestSchema.parse({ fishId: selectedFishId, preparationId: "edible_portion" });
      void createGuideSession(guideRequest, guideController.signal).then((session) => {
        if (guideController.signal.aborted) return;
        setGuideSession(session);
        setGuide(session.guide);
        setActiveStep(session.currentStepIndex);
      }).catch(() => {
        if (!guideController.signal.aborted) {
          setGuideMessage("サーバーに接続できないため、共通の表示モックを使っています。");
        }
      }).finally(() => {
        if (!guideController.signal.aborted) setGuideSessionLoading(false);
      });
    } else {
      setGuideMessage(`${chosenFish}の魚種別ガイドは未登録のため、共通の表示モックを使っています。`);
    }

    void startCamera();
  }

  async function startCamera() {
    setCameraMessage("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus("unavailable");
      setCameraMessage("このブラウザーではカメラを利用できません。画面だけでガイドを確認できます。");
      return;
    }

    const requestId = ++cameraRequestId.current;
    setCameraStatus("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      if (requestId !== cameraRequestId.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setCameraStream(stream);
      setCameraStatus("active");
    } catch (error) {
      if (requestId !== cameraRequestId.current) return;
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      setCameraStatus(denied ? "denied" : "error");
      setCameraMessage(denied
        ? "カメラへのアクセスが許可されませんでした。画面だけでガイドを見ることもできます。"
        : "カメラを起動できませんでした。端末の設定を確認して、もう一度お試しください。");
    }
  }

  function stopCamera() {
    cameraRequestId.current += 1;
    cameraStream?.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
    setCameraStatus("idle");
  }

  function backToFishSelection() {
    guideRequestController.current?.abort();
    guideRequestController.current = null;
    setGuideSessionLoading(false);
    stopCamera();
    setScreen("select");
  }

  async function advanceStep() {
    const nextIndex = Math.min(guide.steps.length - 1, activeStep + 1);
    if (guideAdvanceInFlight.current || guideSession?.status === "completed") return;

    // The session API is authoritative. A locally selected earlier step can be
    // revisited; moving back to the server's current step stays local, and only
    // the next server step is submitted once the UI catches up.
    if (!guideSession) {
      if (nextIndex !== activeStep) setActiveStep(nextIndex);
      return;
    }

    if (activeStep < guideSession.currentStepIndex || activeStep > guideSession.currentStepIndex) {
      if (nextIndex !== activeStep) setActiveStep(nextIndex);
      return;
    }

    if (!guideSession.currentStep) {
      setActiveStep(nextIndex);
      return;
    }

    const signal = guideRequestController.current?.signal;
    if (!signal || signal.aborted) {
      setGuideMessage("ガイドセッションが終了しました。魚を選び直して開始してください。");
      return;
    }

    guideAdvanceInFlight.current = true;
    setGuideAdvancing(true);
    try {
      const session = await advanceGuideSession(guideSession, signal);
      if (signal.aborted) return;
      setGuideSession(session);
      setGuide(session.guide);
      setActiveStep(Math.min(session.currentStepIndex, session.guide.steps.length - 1));
      setGuideMessage(session.status === "completed" ? "このガイドを完了しました。" : "");
    } catch {
      if (!signal.aborted) setGuideMessage("工程を更新できませんでした。現在の手順を確認して、もう一度お試しください。");
    } finally {
      guideAdvanceInFlight.current = false;
      setGuideAdvancing(false);
    }
  }

  const cameraLabel = cameraStatus === "active"
    ? "カメラ稼働中"
    : cameraStatus === "starting"
      ? "カメラ起動中"
      : cameraStatus === "denied"
        ? "カメラの許可が必要"
        : cameraStatus === "unavailable"
          ? "カメラ非対応"
          : cameraStatus === "error"
            ? "カメラ起動失敗"
            : "カメラ未接続";
  const detectionTitle = headTailDetection.status === "active"
    ? "MediaPipeで頭・尾を確認中"
    : headTailDetection.status === "loading"
      ? "認識モデルを準備中"
      : headTailDetection.status === "paused"
        ? "画面非表示中は認識を停止"
        : headTailDetection.status === "unavailable"
          ? "認識モデルが未配置"
          : headTailDetection.status === "error"
            ? "認識を開始できません"
            : "認識は停止中";
  const detectionResult = headTailDetection.status === "active"
    ? headTailDetection.observation?.detections.length
      ? `検出: ${headTailDetection.observation.detections.map((detection) => `${detection.label === "head" ? "頭" : "尾"} ${Math.round(detection.score * 100)}%`).join(" · ")}`
      : "頭・尾を探しています。検出されないことだけでは、切除済みとは判断しません。"
    : headTailDetection.message;

  return (
    <main className={`app-root ${screen === "guide" ? "is-guide" : ""}`}>
      {screen === "select" ? (
        <section className="selector-screen" aria-label="魚を選ぶ">
          <header className="hero">
            <div className="hero-copy">
              <p className="hero-eyebrow">魚さばきガイド</p>
              <h1>俺を捌け！</h1>
              <p>手順を見ながら、<br />落ち着いてさばこう。</p>
            </div>
            <div className="hero-fish-visual" key={selectedFish} aria-live="polite">
              {selectedFishVisualData ? (
              <img className={fishImageClass("hero-fish-photo")} src={fishImage(selectedFishVisualData)} alt={`${selectedFishVisualData.name}のイラスト`} />
              ) : <FishMark />}
              <span>{selectedFishData?.name ?? "魚を選ぼう"}</span>
            </div>
            <span className="hero-glow" aria-hidden="true" />
          </header>

          <div className="selection-content">
            <h2>何の魚をさばく？</h2>
            <label className="search-box">
              <SearchIcon />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder="魚の名前で検索"
                aria-label="魚の名前で検索"
                maxLength={80}
              />
              {search ? <button type="button" aria-label="検索をクリア" onClick={() => setSearch("")}>×</button> : null}
            </label>

            <div className="category-tabs" role="tablist" aria-label="魚のカテゴリ">
              {categories.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={category === item}
                  className={category === item ? "is-active" : ""}
                  onClick={() => setCategory(item)}
                >
                  {item}
                </button>
              ))}
            </div>

            <div className="fish-grid" aria-live="polite">
              {matchingFish.map((fish) => (
                <button
                  key={fish.name}
                  type="button"
                  className={`fish-card${selectedFish === fish.name ? " is-selected" : ""}`}
                  onClick={() => setSelectedFish(fish.name)}
                  aria-pressed={selectedFish === fish.name}
                >
                  <span className="fish-card-image-frame" aria-hidden="true">
                    <img className={fishImageClass("fish-card-photo")} src={fishImage(fish)} alt="" loading="lazy" />
                  </span>
                  <div className="fish-card-copy"><strong>{fish.name}</strong><span>{fish.note}</span></div>
                </button>
              ))}
              {category === "よく使う" && !search ? (
                <button
                  type="button"
                  className={`fish-card fish-card--other${selectedFish === "その他" ? " is-selected" : ""}`}
                  onClick={() => setSelectedFish("その他")}
                  aria-pressed={selectedFish === "その他"}
                >
                  <strong>ほかの魚を探す</strong>
                  <span>深海魚・エビ・カニなど</span>
                </button>
              ) : null}
              {matchingFish.length === 0 && search ? (
                <button type="button" className={`fish-card fish-card--other${selectedFish === "その他" ? " is-selected" : ""}`} onClick={() => setSelectedFish("その他")} aria-pressed={selectedFish === "その他"}>
                  <strong>「{search}」で進む</strong>
                  <span>魚名をそのまま指定</span>
                </button>
              ) : null}
              {matchingFish.length === 0 && !search ? <p className="empty-fish">このカテゴリの魚は準備中です。</p> : null}
            </div>

            <button className="start-button" type="button" disabled={!fishCanContinue} onClick={() => void startGuide()}>
              <strong>ガイドを始める</strong>
              <span>カメラを起動 · 手順は全ての魚に共通</span>
            </button>
          </div>
        </section>
      ) : (
        <section className="guide-screen" aria-label={`${chosenFish}のさばきガイド`}>
          <div className="orientation-screen">
            <div className="orientation-top"><strong>俺を捌け！</strong><span>{cameraLabel}</span></div>
            <div className="orientation-main">
              <RotatePhoneIcon />
              <h1>画面を横に<br />してください</h1>
              <p>横画面で、カメラと共通の手順ガイドを並べて表示します。</p>
              <span className="orientation-fish">選択中：{chosenFish}</span>
              <p className="orientation-hint">工程の自動判定はありません。画面の手順を確認して進めてください。</p>
            </div>
            {cameraMessage ? <p className="orientation-message" role="status">{cameraMessage}</p> : null}
            <button className="orientation-back" type="button" onClick={backToFishSelection}>魚の選択に戻る</button>
            {cameraStatus === "active" ? (
              <button className="camera-stop" type="button" onClick={stopCamera}>カメラを停止</button>
            ) : null}
          </div>

          <div className="landscape-screen">
            <header className="guide-header">
              <button className="back-link" type="button" onClick={backToFishSelection} aria-label="魚の選択に戻る">←</button>
              <div className="guide-brand"><strong>俺を捌け！</strong><span>{chosenFish}</span></div>
              <span className={`camera-badge ${cameraStatus === "active" ? "is-live" : ""}`}><i />{cameraLabel}</span>
            </header>

            <div className="guide-layout">
              <section className="camera-card" aria-label="カメラプレビュー">
                <div className="camera-topline"><span>カメラプレビュー</span><span>映像は送信されません</span></div>
                {cameraStream ? (
                  <video ref={videoRef} autoPlay muted playsInline aria-label="カメラ映像" />
                ) : (
                  <div className="camera-placeholder">
                    <CameraPlaceholderIcon />
                    <p>{cameraStatus === "starting" ? "カメラを起動しています…" : "カメラ映像はここに表示されます"}</p>
                    {cameraStatus !== "starting" ? <button type="button" onClick={() => void startCamera()}>カメラを起動</button> : null}
                  </div>
                )}
                {headTailDetection.observation && videoRef.current && videoRef.current.videoWidth > 0 ? (
                  <DetectionOverlay
                    observation={headTailDetection.observation}
                    width={videoRef.current.videoWidth}
                    height={videoRef.current.videoHeight}
                  />
                ) : null}
              </section>

              <aside className="guide-panel">
                <div className="guide-panel-heading"><div><span>全魚共通の手動ガイド</span><h1>さばき手順</h1></div><strong>{String(activeStep + 1).padStart(2, "0")} <i>/</i> {String(guide.steps.length).padStart(2, "0")}</strong></div>
                <div className="guide-progress" aria-label={`${activeStep + 1} / ${guide.steps.length}`}>
                  {guide.steps.map((step, index) => <span key={step.id} className={index <= activeStep ? "is-active" : ""} />)}
                </div>
                {currentStep ? (
                  <div className="guide-step" aria-live="polite">
                    <h2>{currentStep.title}</h2>
                    <p>{currentStep.description}</p>
                  </div>
                ) : null}
                {guideMessage ? <p className="guide-message" role="status">{guideMessage}</p> : null}
                <div className="observation-note" data-state={headTailDetection.status} role="status" aria-live="polite">
                  <span>{headTailDetection.status === "active" ? "AI" : "INFO"}</span>
                  <p><strong>{detectionTitle}</strong><small>{detectionResult} 工程は自動で進みません。</small></p>
                </div>
                <div className="guide-controls">
                  <button type="button" onClick={() => setActiveStep((step) => Math.max(0, step - 1))} disabled={activeStep === 0}>戻る</button>
                  <button type="button" onClick={() => void advanceStep()} disabled={guideSessionLoading || guideAdvancing || (activeStep >= guide.steps.length - 1 && (!guideSession || guideSession.status === "completed"))}>{guideSessionLoading ? "準備中…" : guideAdvancing ? "更新中…" : guideSession?.status === "completed" ? "完了" : activeStep >= guide.steps.length - 1 ? "ガイドを完了" : "次の工程へ"} <span>→</span></button>
                </div>
              </aside>
            </div>
            {cameraMessage ? <p className="camera-message" role="status">{cameraMessage}</p> : null}
          </div>
        </section>
      )}
    </main>
  );
}

function DetectionOverlay({ observation, width, height }: { observation: Observation; width: number; height: number }) {
  return (
    <svg
      className="detection-overlay"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="MediaPipeが検出した魚の頭と尾の位置"
    >
      {observation.detections.map((detection, index) => {
        const x = detection.box.x * width;
        const y = detection.box.y * height;
        const boxWidth = detection.box.width * width;
        const boxHeight = detection.box.height * height;
        const label = detection.label === "head" ? "頭" : "尾";
        const color = detection.label === "head" ? "var(--gold)" : "#7adbb0";
        const fontSize = Math.max(16, width * 0.022);

        return (
          <g key={`${detection.label}-${index}`}>
            <rect x={x} y={y} width={boxWidth} height={boxHeight} fill="none" stroke={color} strokeWidth={Math.max(3, width * 0.004)} vectorEffect="non-scaling-stroke" />
            <text x={x} y={Math.max(fontSize, y - 6)} fill={color} fontSize={fontSize}>
              {label} {Math.round(detection.score * 100)}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default App;
