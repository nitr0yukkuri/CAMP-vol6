import { useEffect, useMemo, useRef, useState } from "react";
import { AdvanceGuideStepRequestSchema, GuideContextRequestSchema, GuideRequestSchema, GuideSessionSchema, MOCK_GUIDE, type FishCategory, type Guide, type GuideContextRequest, type GuideRequest, type GuideSession, type Observation } from "@orewosabake/contracts";
import { useHeadTailDetection, type HeadTailDetectionStatus } from "./hooks/useHeadTailDetection";

type Category = "よく使う" | "海水魚" | "淡水魚" | "甲殻類";
type Screen = "select" | "guide" | "capture";
type CameraStatus = "idle" | "starting" | "active" | "denied" | "unavailable" | "error";
type CaptureStage = "whole" | "head_removed" | "gutted" | "filleting" | "finished" | "other" | "unknown";
type PartVisibility = "present_visible" | "removed_confirmed" | "occluded" | "out_of_frame" | "unknown";
type PresenceStatus = "true" | "false" | "unknown";
type CaptureLabelSource = "unknown" | "ai_suggestion" | "manual";

type CaptureRow = {
  fish_species: string;
  session_id: string;
  fish_id: string;
  frame_id: string;
  relative_time_ms: number;
  frame_path: string;
  confirmed_stage: CaptureStage;
  head_status: PartVisibility;
  head_status_source: CaptureLabelSource;
  tail_status: PartVisibility;
  tail_status_source: CaptureLabelSource;
  hands_visible: PresenceStatus;
  knife_visible: PresenceStatus;
  occlusion: string;
  device_model: string;
  camera_view: string;
  lighting: string;
  review_status: "reviewed" | "needs_review";
  notes: string;
  ai_status: HeadTailDetectionStatus;
  ai_observation_json: string;
};

type Fish = {
  name: string;
  category: Exclude<Category, "よく使う">;
  mascot: string;
  searchAliases?: string[];
  popular?: boolean;
};

const categories: Category[] = ["よく使う", "海水魚", "淡水魚", "甲殻類"];
const fishList: Fish[] = [
  { name: "マグロ", category: "海水魚", mascot: "maguro", popular: true },
  { name: "サーモン", category: "海水魚", mascot: "salmon", popular: true },
  { name: "ハマチ", category: "海水魚", mascot: "hamachi", searchAliases: ["はまち"], popular: true },
  { name: "アジ", category: "海水魚", mascot: "aji", popular: true },
  { name: "サバ", category: "海水魚", mascot: "saba", popular: true },
  { name: "タイ", category: "海水魚", mascot: "tai", searchAliases: ["鯛", "たい"] },
  { name: "鮎", category: "淡水魚", mascot: "ayu", searchAliases: ["アユ", "あゆ"] },
  { name: "エビ", category: "甲殻類", mascot: "ebi" },
  { name: "カニ", category: "甲殻類", mascot: "kani" },
  { name: "イカ", category: "海水魚", mascot: "ika" },
  { name: "タコ", category: "海水魚", mascot: "tako" },
  { name: "イワシ", category: "海水魚", mascot: "iwashi" },
  { name: "ぶり", category: "海水魚", mascot: "buri", searchAliases: ["ブリ"] },
  { name: "カツオ", category: "海水魚", mascot: "katsuo" },
  { name: "ヒラメ", category: "海水魚", mascot: "hirame" },
  { name: "カレイ", category: "海水魚", mascot: "karei" },
  { name: "ウナギ", category: "淡水魚", mascot: "unagi" },
  { name: "アナゴ", category: "海水魚", mascot: "anago" },
  { name: "はも", category: "海水魚", mascot: "hamo", searchAliases: ["ハモ"] },
  { name: "太刀魚", category: "海水魚", mascot: "tachiuo", searchAliases: ["タチウオ"] },
  { name: "カワハギ", category: "海水魚", mascot: "kawahagi" },
];

const MAX_CAPTURE_FRAMES = 60;
const MAX_CAPTURE_FRAME_DIMENSION = 832;
const CAPTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function createCaptureSessionId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `pilot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${suffix}`;
}

function csvCell(value: string | number | boolean): string {
  let text = String(value);
  if (/^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function captureRowsToCsv(rows: CaptureRow[]): string {
  const columns: Array<keyof CaptureRow> = [
    "fish_species", "session_id", "fish_id", "frame_id", "relative_time_ms", "frame_path", "confirmed_stage",
    "head_status", "head_status_source", "tail_status", "tail_status_source", "hands_visible", "knife_visible", "occlusion", "device_model",
    "camera_view", "lighting", "review_status", "notes", "ai_status", "ai_observation_json",
  ];
  return `\uFEFF${columns.join(",")}\r\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\r\n")}\r\n`;
}

function downloadCaptureFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fishImage(fish: Fish): string {
  return `/fish-mascots-transparent/${fish.mascot}.png`;
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

function CameraStopIcon() {
  return (
    <svg className="camera-stop-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" />
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
  const [selectedFish, setSelectedFish] = useState("ハマチ");
  const [guide, setGuide] = useState<Guide>(MOCK_GUIDE);
  const [guideSession, setGuideSession] = useState<GuideSession | null>(null);
  const [guideSessionLoading, setGuideSessionLoading] = useState(false);
  const [guideMessage, setGuideMessage] = useState("");
  const [guideAdvancing, setGuideAdvancing] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("idle");
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraMessage, setCameraMessage] = useState("");
  const [captureSessionId, setCaptureSessionId] = useState(createCaptureSessionId);
  const [captureFishId, setCaptureFishId] = useState("fish-001");
  const [captureStage, setCaptureStage] = useState<CaptureStage>("unknown");
  const [captureHeadStatus, setCaptureHeadStatus] = useState<PartVisibility>("unknown");
  const [captureHeadStatusSource, setCaptureHeadStatusSource] = useState<CaptureLabelSource>("unknown");
  const [captureTailStatus, setCaptureTailStatus] = useState<PartVisibility>("unknown");
  const [captureTailStatusSource, setCaptureTailStatusSource] = useState<CaptureLabelSource>("unknown");
  const [captureHandsVisible, setCaptureHandsVisible] = useState<PresenceStatus>("unknown");
  const [captureKnifeVisible, setCaptureKnifeVisible] = useState<PresenceStatus>("unknown");
  const [captureOcclusion, setCaptureOcclusion] = useState("unknown");
  const [captureDeviceModel, setCaptureDeviceModel] = useState("");
  const [captureCameraView, setCaptureCameraView] = useState("unknown");
  const [captureLighting, setCaptureLighting] = useState("unknown");
  const [captureReviewed, setCaptureReviewed] = useState(false);
  const [captureNotes, setCaptureNotes] = useState("");
  const [captureRows, setCaptureRows] = useState<CaptureRow[]>([]);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureMessage, setCaptureMessage] = useState("");
  const [captureManifestExported, setCaptureManifestExported] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureStartedAt = useRef<number | null>(null);
  const cameraRequestId = useRef(0);
  const guideRequestController = useRef<AbortController | null>(null);
  const guideAdvanceInFlight = useRef(false);
  const headTailDetection = useHeadTailDetection(
    videoRef,
    (screen === "guide" || screen === "capture") && cameraStatus === "active" && cameraStream !== null,
  );

  useEffect(() => {
    if (screen !== "capture") return;
    const visibleParts = new Set(headTailDetection.observation?.detections.map((detection) => detection.label) ?? []);
    let suggested = false;

    if (captureHeadStatusSource !== "manual") {
      const nextStatus = visibleParts.has("head") ? "present_visible" : "unknown";
      const nextSource = visibleParts.has("head") ? "ai_suggestion" : "unknown";
      if (captureHeadStatus !== nextStatus || captureHeadStatusSource !== nextSource) {
        setCaptureHeadStatus(nextStatus);
        setCaptureHeadStatusSource(nextSource);
        suggested = true;
      }
    }
    if (captureTailStatusSource !== "manual") {
      const nextStatus = visibleParts.has("tail") ? "present_visible" : "unknown";
      const nextSource = visibleParts.has("tail") ? "ai_suggestion" : "unknown";
      if (captureTailStatus !== nextStatus || captureTailStatusSource !== nextSource) {
        setCaptureTailStatus(nextStatus);
        setCaptureTailStatusSource(nextSource);
        suggested = true;
      }
    }
    if (suggested) setCaptureReviewed(false);
  }, [
    captureHeadStatus,
    captureHeadStatusSource,
    captureTailStatus,
    captureTailStatusSource,
    headTailDetection.observation,
    screen,
  ]);

  useEffect(() => () => guideRequestController.current?.abort(), []);

  useEffect(() => {
    if (screen !== "capture" || captureRows.length === 0 || captureManifestExported) return;
    const warnAboutUnsavedLabels = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnAboutUnsavedLabels);
    return () => window.removeEventListener("beforeunload", warnAboutUnsavedLabels);
  }, [captureManifestExported, captureRows.length, screen]);

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
      setCameraMessage(screen === "capture"
        ? "このブラウザーではカメラを利用できません。撮影にはカメラ対応ブラウザーをご利用ください。"
        : "このブラウザーではカメラを利用できません。画面だけでガイドを確認できます。");
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
      if (screen === "capture" && captureStartedAt.current === null) captureStartedAt.current = performance.now();
      setCameraStream(stream);
      setCameraStatus("active");
    } catch (error) {
      if (requestId !== cameraRequestId.current) return;
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      setCameraStatus(denied ? "denied" : "error");
      setCameraMessage(denied
        ? screen === "capture"
          ? "カメラへのアクセスが許可されていません。ブラウザー設定で許可してから再試行してください。"
          : "カメラへのアクセスが許可されませんでした。画面だけでガイドを見ることもできます。"
        : "カメラを起動できませんでした。端末の設定を確認して、もう一度お試しください。");
    }
  }

  function stopCamera() {
    cameraRequestId.current += 1;
    cameraStream?.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
    setCameraStatus("idle");
    setCameraMessage("");
  }

  function startCapture() {
    setCaptureSessionId(createCaptureSessionId());
    setCaptureRows([]);
    setCaptureManifestExported(false);
    setCaptureMessage("");
    setCameraMessage("");
    setCaptureStage("unknown");
    setCaptureHeadStatus("unknown");
    setCaptureHeadStatusSource("unknown");
    setCaptureTailStatus("unknown");
    setCaptureTailStatusSource("unknown");
    setCaptureHandsVisible("unknown");
    setCaptureKnifeVisible("unknown");
    setCaptureOcclusion("unknown");
    setCaptureCameraView("unknown");
    setCaptureLighting("unknown");
    setCaptureNotes("");
    setCaptureReviewed(false);
    captureStartedAt.current = null;
    setScreen("capture");
  }

  function backFromCapture() {
    if (captureRows.length > 0 && !captureManifestExported) {
      const shouldLeave = window.confirm("撮影画像は個別に保存済みですが、CSVのラベル一覧はまだ保存されていません。この画面を閉じますか？");
      if (!shouldLeave) return;
    }
    stopCamera();
    setScreen("select");
  }

  async function saveCaptureFrame() {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth < 1 || video.videoHeight < 1) {
      setCaptureMessage("カメラ映像の準備ができるまで待ってください。");
      return;
    }
    if (!CAPTURE_ID_PATTERN.test(captureSessionId) || !CAPTURE_ID_PATTERN.test(captureFishId)) {
      setCaptureMessage("撮影IDと魚IDは英数字、ピリオド、ハイフン、アンダースコアで入力してください。");
      return;
    }
    if (captureRows.length >= MAX_CAPTURE_FRAMES) {
      setCaptureMessage(`1セッションの上限${MAX_CAPTURE_FRAMES}枚に達しました。CSVを保存してください。`);
      return;
    }

    setCaptureBusy(true);
    setCaptureMessage("");
    try {
      const scale = Math.min(1, MAX_CAPTURE_FRAME_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("2D canvas is unavailable");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode capture frame")), "image/jpeg", 0.88);
      });

      const nextFrameNumber = captureRows.length + 1;
      const frameId = `frame-${String(nextFrameNumber).padStart(4, "0")}`;
      const filename = `${captureSessionId}_${captureFishId}_${frameId}.jpg`;
      const row: CaptureRow = {
        fish_species: chosenFish,
        session_id: captureSessionId,
        fish_id: captureFishId,
        frame_id: frameId,
        relative_time_ms: Math.max(0, Math.round(performance.now() - (captureStartedAt.current ?? performance.now()))),
        frame_path: filename,
        confirmed_stage: captureStage,
        head_status: captureHeadStatus,
        head_status_source: captureHeadStatusSource,
        tail_status: captureTailStatus,
        tail_status_source: captureTailStatusSource,
        hands_visible: captureHandsVisible,
        knife_visible: captureKnifeVisible,
        occlusion: captureOcclusion,
        device_model: captureDeviceModel.trim() || "unknown",
        camera_view: captureCameraView,
        lighting: captureLighting,
        review_status: captureReviewed ? "reviewed" : "needs_review",
        notes: captureNotes.trim(),
        ai_status: headTailDetection.status,
        ai_observation_json: headTailDetection.observation ? JSON.stringify(headTailDetection.observation) : "",
      };

      downloadCaptureFile(imageBlob, filename);
      setCaptureRows((rows) => [...rows, row]);
      setCaptureManifestExported(false);
      setCaptureMessage(`${filename} を端末へ保存しました。ラベルを確認して次のフレームを撮れます。`);
    } catch {
      setCaptureMessage("画像を保存できませんでした。ブラウザーのダウンロード許可と空き容量を確認してください。");
    } finally {
      setCaptureBusy(false);
    }
  }

  function exportCaptureManifest() {
    if (captureRows.length === 0) return;
    const csv = captureRowsToCsv(captureRows);
    const safeSessionId = CAPTURE_ID_PATTERN.test(captureSessionId) ? captureSessionId : "fish-capture";
    downloadCaptureFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${safeSessionId}_capture-manifest.csv`);
    setCaptureManifestExported(true);
    setCaptureMessage("CSVを保存しました。画像とCSVを同じフォルダーに置いてください。");
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

  const detectionTitle = headTailDetection.status === "active"
    ? "MediaPipe試験モデルで頭・尾を確認中"
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
    <main className={`app-root ${screen === "guide" ? "is-guide" : screen === "capture" ? "is-capture" : ""}`}>
      {screen === "select" ? (
        <section className="selector-screen" aria-label="魚を選ぶ">
          <header className="hero">
            <div className="hero-copy">
              <h1>俺を捌け！</h1>
            </div>
            <div className="hero-fish-visual" key={selectedFish} aria-live="polite">
              {selectedFishVisualData ? (
              <img className={fishImageClass("hero-fish-photo")} src={fishImage(selectedFishVisualData)} alt={`${selectedFishVisualData.name}のイラスト`} />
              ) : <FishMark />}
            </div>
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
                  <div className="fish-card-copy"><strong>{fish.name}</strong></div>
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
                </button>
              ) : null}
              {matchingFish.length === 0 && search ? (
                <button type="button" className={`fish-card fish-card--other${selectedFish === "その他" ? " is-selected" : ""}`} onClick={() => setSelectedFish("その他")} aria-pressed={selectedFish === "その他"}>
                  <strong>「{search}」で進む</strong>
                </button>
              ) : null}
              {matchingFish.length === 0 && !search ? <p className="empty-fish">このカテゴリの魚は準備中です。</p> : null}
            </div>

            <button className="start-button" type="button" disabled={!fishCanContinue} onClick={() => void startGuide()}>
              <strong>俺を捌け！</strong>
              <span>カメラを起動・手順は全ての魚に共通</span>
            </button>
            <button className="capture-entry-button" type="button" disabled={!fishCanContinue} onClick={startCapture}>
              研究用データを撮る
            </button>
          </div>
        </section>
      ) : screen === "capture" ? (
        <section className="capture-screen" aria-label="研究用データ撮影">
          <header className="capture-header">
            <button className="back-link" type="button" onClick={backFromCapture} aria-label="魚の選択に戻る">←</button>
            <div className="guide-brand"><strong>研究用データ収集</strong><span>{chosenFish} · カメラ画像はアップロードされません</span></div>
          </header>

          <p className="capture-intro">AIの頭・尾候補を確認し、人がラベルを選んで撮影します。画像は端末に保存し、AI候補と選択ラベルをCSVに記録します。</p>

          <div className="capture-layout">
            <section className="camera-card capture-camera-card" aria-label="AI撮影プレビュー">
              <div className="capture-preview">
                <div className="camera-topline"><span>AIライブプレビュー</span><span>映像は端末内で処理</span></div>
                {cameraStream ? (
                  <>
                    <video ref={videoRef} autoPlay muted playsInline aria-label="AIが確認するカメラ映像" />
                    {headTailDetection.observation && videoRef.current && videoRef.current.videoWidth > 0 ? (
                      <DetectionOverlay
                        observation={headTailDetection.observation}
                        width={videoRef.current.videoWidth}
                        height={videoRef.current.videoHeight}
                        fit="contain"
                      />
                    ) : null}
                  </>
                ) : (
                  <div className="camera-placeholder">
                    <CameraPlaceholderIcon />
                    <p>{cameraStatus === "starting" ? "カメラを起動しています…" : cameraMessage || "撮影を始めるにはカメラを起動してください"}</p>
                    {cameraStatus !== "starting" ? <button type="button" onClick={() => void startCamera()}>{cameraStatus === "error" || cameraStatus === "denied" || cameraStatus === "unavailable" ? "カメラを再試行" : "カメラを起動"}</button> : null}
                  </div>
                )}
              </div>
              <div className="capture-camera-actions">
                <span>{captureRows.length} / {MAX_CAPTURE_FRAMES} 枚 保存済み</span>
                <button type="button" onClick={() => void saveCaptureFrame()} disabled={cameraStatus !== "active" || captureBusy || captureRows.length >= MAX_CAPTURE_FRAMES}>
                  {captureBusy ? "保存中…" : "撮影して保存"}
                </button>
                {cameraStatus === "active" ? <button className="capture-stop-button" type="button" onClick={stopCamera} aria-label="カメラを停止"><CameraStopIcon /></button> : null}
              </div>
            </section>

            <div className="capture-panel">
              <div className="capture-panel-heading"><div><span>AI候補を人が確認</span><h1>撮影ラベル</h1></div><span>不明のまま保存できます</span></div>
              <div className="observation-note capture-ai-note" data-state={headTailDetection.status} aria-live="off">
                <span>AI</span>
                <p>
                  <strong>{detectionTitle}</strong>
                  <small>{detectionResult}</small>
                  <small>検出した頭・尾だけ「見える」を仮入力します。工程や他の項目は対象外なので、不明から始まります。検出なしは切除済みを意味しません。</small>
                </p>
              </div>
              <div className="capture-field-grid">
                <label className="capture-field"><span>撮影セッションID</span><input value={captureSessionId} onChange={(event) => setCaptureSessionId(event.currentTarget.value)} maxLength={64} disabled={captureRows.length > 0} /></label>
                <label className="capture-field"><span>魚ID（同じ魚は同じID）</span><input value={captureFishId} onChange={(event) => setCaptureFishId(event.currentTarget.value)} maxLength={64} /></label>
                <label className="capture-field"><span>魚種</span><input value={chosenFish} readOnly /></label>
                <label className="capture-field"><span>確認した工程</span><select value={captureStage} onChange={(event) => { setCaptureStage(event.currentTarget.value as CaptureStage); setCaptureReviewed(false); }}>
                  <option value="unknown">未確認</option><option value="whole">未処理</option><option value="head_removed">頭を外した</option><option value="gutted">内臓処理済み</option><option value="filleting">身を分けている途中</option><option value="finished">工程完了</option><option value="other">その他</option>
                </select></label>
                <label className="capture-field"><span>頭の状態{captureHeadStatusSource === "ai_suggestion" ? " · AI仮入力" : ""}</span><select value={captureHeadStatus} onChange={(event) => { setCaptureHeadStatus(event.currentTarget.value as PartVisibility); setCaptureHeadStatusSource("manual"); setCaptureReviewed(false); }}>
                  <option value="unknown">未確認</option><option value="present_visible">付いている・見える</option><option value="removed_confirmed">切除済みと確認</option><option value="occluded">遮蔽されている</option><option value="out_of_frame">画角外</option>
                </select></label>
                <label className="capture-field"><span>尾の状態{captureTailStatusSource === "ai_suggestion" ? " · AI仮入力" : ""}</span><select value={captureTailStatus} onChange={(event) => { setCaptureTailStatus(event.currentTarget.value as PartVisibility); setCaptureTailStatusSource("manual"); setCaptureReviewed(false); }}>
                  <option value="unknown">未確認</option><option value="present_visible">付いている・見える</option><option value="removed_confirmed">切除済みと確認</option><option value="occluded">遮蔽されている</option><option value="out_of_frame">画角外</option>
                </select></label>
                <label className="capture-field"><span>遮蔽の主な理由</span><select value={captureOcclusion} onChange={(event) => { setCaptureOcclusion(event.currentTarget.value); setCaptureReviewed(false); }}>
                  <option value="unknown">不明</option><option value="none">なし</option><option value="hands">手</option><option value="knife">包丁</option><option value="container">容器・器具</option><option value="overlap">魚や物との重なり</option><option value="other">その他</option>
                </select></label>
                <label className="capture-field"><span>カメラ角度</span><select value={captureCameraView} onChange={(event) => { setCaptureCameraView(event.currentTarget.value); setCaptureReviewed(false); }}>
                  <option value="unknown">不明</option><option value="overhead">真上</option><option value="oblique">斜め上</option><option value="side">横</option><option value="other">その他</option>
                </select></label>
                <label className="capture-field"><span>照明</span><select value={captureLighting} onChange={(event) => { setCaptureLighting(event.currentTarget.value); setCaptureReviewed(false); }}>
                  <option value="unknown">不明</option><option value="daylight">自然光</option><option value="indoor-led">室内LED</option><option value="dim">暗め</option><option value="other">その他</option>
                </select></label>
                <label className="capture-field"><span>端末機種（任意）</span><input value={captureDeviceModel} onChange={(event) => { setCaptureDeviceModel(event.currentTarget.value); setCaptureReviewed(false); }} maxLength={120} placeholder="不明（任意）" /></label>
              </div>

              <div className="capture-checks">
                <label><input type="checkbox" checked={captureReviewed} onChange={(event) => setCaptureReviewed(event.currentTarget.checked)} />このラベルを見直した</label>
              </div>
              <div className="capture-field-grid capture-presence-grid">
                <label className="capture-field"><span>手の映り込み</span><select value={captureHandsVisible} onChange={(event) => { setCaptureHandsVisible(event.currentTarget.value as PresenceStatus); setCaptureReviewed(false); }}><option value="unknown">不明</option><option value="true">映っている</option><option value="false">映っていない</option></select></label>
                <label className="capture-field"><span>包丁の映り込み</span><select value={captureKnifeVisible} onChange={(event) => { setCaptureKnifeVisible(event.currentTarget.value as PresenceStatus); setCaptureReviewed(false); }}><option value="unknown">不明</option><option value="true">映っている</option><option value="false">映っていない</option></select></label>
              </div>
              <label className="capture-field"><span>メモ（任意）</span><textarea value={captureNotes} onChange={(event) => setCaptureNotes(event.currentTarget.value)} maxLength={500} rows={2} placeholder="反射、画角、作業中など" /></label>
              <p className="capture-label-hint">頭や尾が映らないだけでは「切除済み」にしないでください。隠れている場合は「遮蔽」、画面外なら「画角外」、判断できなければ「未確認」を選びます。</p>

              <div className="capture-export-row">
                <button className="capture-export-button" type="button" onClick={exportCaptureManifest} disabled={captureRows.length === 0}>CSVラベル一覧を保存</button>
                <span>{captureRows.length ? `${captureRows.length} 枚分のラベル` : "撮影すると保存できます"}</span>
              </div>
              {captureMessage ? <p className="capture-message" role="status" aria-live="polite">{captureMessage}</p> : null}
              {captureRows.length > 0 ? <div className="capture-recent" aria-label="撮影済みの最新フレーム"><strong>撮影済み · 最新{Math.min(3, captureRows.length)}枚</strong>{captureRows.slice(-3).reverse().map((row) => <span key={row.frame_id}>{row.frame_path} · {row.confirmed_stage} · 頭 {row.head_status} / 尾 {row.tail_status}</span>)}</div> : null}
            </div>
          </div>
        </section>
      ) : (
        <section className="guide-screen" aria-label={`${chosenFish}のさばきガイド`}>
          <div className="orientation-screen">
            <div className="orientation-top">
              <button className="orientation-back" type="button" onClick={backToFishSelection} aria-label="魚の選択に戻る">
                <span aria-hidden="true">←</span><span>魚の選択に戻る</span>
              </button>
              <strong>俺を捌け！</strong>
            </div>
            <div className="orientation-main">
              <RotatePhoneIcon />
              <h1>画面を横に<br />してください</h1>
              <p>横画面で、カメラと共通の手順ガイドを並べて表示します。</p>
              <span className="orientation-fish">選択中：{chosenFish}</span>
              <p className="orientation-hint">工程の自動判定はありません。画面の手順を確認して進めてください。</p>
            </div>
            {cameraMessage ? <p className="orientation-message" role="status">{cameraMessage}</p> : null}
            {cameraStatus === "active" ? (
              <button className="camera-stop" type="button" onClick={stopCamera} aria-label="カメラを停止"><CameraStopIcon /></button>
            ) : null}
          </div>

          <div className="landscape-screen">
            <header className="guide-header">
              <button className="back-link" type="button" onClick={backToFishSelection} aria-label="魚の選択に戻る">
                <span aria-hidden="true">←</span><span className="back-link-label">魚の選択に戻る</span>
              </button>
              <div className="guide-brand"><strong>{chosenFish}先生のさばきガイド</strong></div>
              <div className="guide-header-progress" aria-label={`工程 ${activeStep + 1} / ${guide.steps.length}`}>
                <strong>STEP {activeStep + 1} / {guide.steps.length}</strong>
                <div className="guide-progress" aria-hidden="true">
                  {guide.steps.map((step, index) => <span key={step.id} className={index <= activeStep ? "is-active" : ""} />)}
                </div>
              </div>
              {cameraStatus === "active" ? <button className="camera-stop-inline" type="button" onClick={stopCamera} aria-label="カメラを停止"><CameraStopIcon /></button> : null}
            </header>

            <div className="guide-layout">
              <div className="guide-stage">
                <section className="camera-card" aria-label="カメラプレビュー">
                  <div className="camera-topline"><span>カメラプレビュー</span><span>映像は送信されません</span></div>
                  {cameraStream ? (
                    <video ref={videoRef} autoPlay muted playsInline aria-label="カメラ映像" />
                  ) : (
                    <div className="camera-placeholder">
                      <CameraPlaceholderIcon />
                      <p>{cameraStatus === "starting" ? "カメラを起動しています…" : cameraMessage || "カメラ映像はここに表示されます"}</p>
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

                <aside className="guide-fish-stage" aria-label={`${chosenFish}先生`}>
                  <div className="guide-fish-bubble">一緒に確認しよう！</div>
                  {selectedFishVisualData ? (
                    <img
                      className={fishImageClass("guide-fish-image")}
                      src={fishImage(selectedFishVisualData)}
                      alt={`${selectedFishVisualData.name}先生`}
                    />
                  ) : null}
                </aside>
              </div>

              <aside className="guide-panel">
                {currentStep ? (
                  <div className="guide-step" aria-live="polite">
                    <h2>{currentStep.title}</h2>
                    <p>{currentStep.description}</p>
                    {guideMessage ? <p className="guide-message" role="status">{guideMessage}</p> : null}
                  </div>
                ) : null}
                <div className="observation-note" data-state={headTailDetection.status} aria-live="off">
                  <span>{headTailDetection.status === "active" ? "AI" : "INFO"}</span>
                  <p>
                    <strong>{detectionTitle}</strong>
                    <small>{detectionResult} 工程は自動で進みません。</small>
                    <small className="model-scope-note">公開魚画像で学習した試験モデルです。調理台の魚では未検証です。</small>
                  </p>
                </div>
                <div className="guide-actions">
                  <div className="guide-controls">
                    <button type="button" onClick={() => setActiveStep((step) => Math.max(0, step - 1))} disabled={activeStep === 0}>戻る</button>
                    <button type="button" onClick={() => void advanceStep()} disabled={guideSessionLoading || guideAdvancing || (activeStep >= guide.steps.length - 1 && (!guideSession || guideSession.status === "completed"))}>{guideSessionLoading ? "準備中…" : guideAdvancing ? "更新中…" : guideSession?.status === "completed" ? "完了" : activeStep >= guide.steps.length - 1 ? "ガイドを完了" : "次の工程へ"} <span>→</span></button>
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

function DetectionOverlay({ observation, width, height, fit = "cover" }: { observation: Observation; width: number; height: number; fit?: "cover" | "contain" }) {
  return (
    <svg
      className="detection-overlay"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={fit === "contain" ? "xMidYMid meet" : "xMidYMid slice"}
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
