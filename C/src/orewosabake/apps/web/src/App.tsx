import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AdvanceGuideStepRequestSchema, getPreparationIdForFish, getReferenceGuide, GuideImageAnalysisResponseSchema, GuideRequestSchema, GuideSessionSchema, resolveGuideFishId, type GuideImageAnalysisResponse, type GuideRequest, type GuideSession, type Observation } from "@orewosabake/contracts";
import { useHeadTailDetection, type HeadTailDetectionStatus } from "./hooks/useHeadTailDetection";
import { fishStageLabel, stageToExpectedFishState } from "./model/fishStage";

type Category = "よく使う" | "海水魚" | "淡水魚" | "甲殻類";
type Screen = "select" | "guide" | "capture";
type GuideSessionMode = "worker" | "local";
type CameraStatus = "idle" | "starting" | "active" | "denied" | "unavailable" | "error";
type CaptureStage = "whole" | "head_removed" | "gutted" | "filleting" | "finished" | "other" | "unknown";
type PartVisibility = "present_visible" | "removed_confirmed" | "occluded" | "out_of_frame" | "unknown";
type PresenceStatus = "true" | "false" | "unknown";
type CaptureLabelSource = "unknown" | "ai_suggestion" | "manual";
type CapturePart = "head" | "tail";
type CaptureBox = { x: number; y: number; width: number; height: number };

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
  head_bbox_x: string;
  head_bbox_y: string;
  head_bbox_width: string;
  head_bbox_height: string;
  head_bbox_source: "manual" | "unknown";
  tail_bbox_x: string;
  tail_bbox_y: string;
  tail_bbox_width: string;
  tail_bbox_height: string;
  tail_bbox_source: "manual" | "unknown";
};

type PendingCapture = {
  kind: "head_tail" | "stage";
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
  row: CaptureRow;
  activePart: CapturePart;
  headBox: CaptureBox | null;
  tailBox: CaptureBox | null;
  dragStart: { x: number; y: number } | null;
  draftBox: CaptureBox | null;
};

type GeminiAutoDetectionWatch = {
  lastObservationAt: string | null;
  candidateSignature: string | null;
  candidateCount: number;
  candidateCapturedAtMs: number | null;
  stableSignature: string | null;
  pending: boolean;
  lastTriggeredAt: number;
  retryCount: number;
  retryAtMs: number;
};

function createGeminiAutoDetectionWatch(): GeminiAutoDetectionWatch {
  return {
    lastObservationAt: null,
    candidateSignature: null,
    candidateCount: 0,
    candidateCapturedAtMs: null,
    stableSignature: null,
    pending: false,
    lastTriggeredAt: 0,
    retryCount: 0,
    retryAtMs: 0,
  };
}

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
const GEMINI_AUTO_STABLE_OBSERVATIONS = 3;
const GEMINI_AUTO_MAX_FRAME_GAP_MS = 2_500;
const GEMINI_AUTO_MAX_OBSERVATION_AGE_MS = 2_000;
const GEMINI_AUTO_MIN_INTERVAL_MS = 10_000;
const GEMINI_AUTO_RETRY_DELAYS_MS = [15_000, 30_000, 60_000] as const;

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
    "head_bbox_x", "head_bbox_y", "head_bbox_width", "head_bbox_height", "head_bbox_source",
    "tail_bbox_x", "tail_bbox_y", "tail_bbox_width", "tail_bbox_height", "tail_bbox_source",
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
  return `/fish-mascots-transparent-clean/${fish.mascot}.png`;
}

function fishImageClass(baseClass: string): string {
  return `${baseClass} is-mascot`;
}

async function createGuideSession(requestBody: GuideRequest, signal: AbortSignal): Promise<GuideSession> {
  let response: Response;
  try {
    response = await fetch("/api/guide/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(GuideRequestSchema.parse(requestBody)),
      signal,
    });
  } catch (error) {
    if (error instanceof TypeError) throw new GuideApiUnavailableError();
    throw error;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const payload = contentType.includes("application/json")
      ? await response.clone().json().catch(() => null) as { error?: { code?: string; message?: string } } | null
      : null;
    if (payload?.error?.code === "GUIDE_NOT_AVAILABLE") {
      throw new GuideNotAvailableError(payload.error.message ?? "この魚の参考手順はまだ登録されていません。");
    }
    const apiRouteMissing = response.status === 404 || response.status === 405;
    if (apiRouteMissing && (!payload?.error?.code || ["NOT_FOUND", "METHOD_NOT_ALLOWED"].includes(payload.error.code))) {
      throw new GuideApiUnavailableError();
    }
    throw new Error("Guide session API rejected the request");
  }
  if (!contentType.includes("application/json")) throw new GuideApiUnavailableError();
  return GuideSessionSchema.parse(await response.json());
}

async function analyzeGuideImage(
  requestBody: { fishId: GuideRequest["fishId"]; stepId: string; imageData: string },
  signal: AbortSignal,
): Promise<GuideImageAnalysisResponse> {
  const response = await fetch("/api/guide/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal,
  });
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | GuideImageAnalysisResponse | null;
  if (!response.ok) {
    const message = payload && "error" in payload ? payload.error?.message : undefined;
    throw new Error(message || "画像をAIで確認できませんでした。時間をおいて再試行してください。");
  }
  return GuideImageAnalysisResponseSchema.parse(payload);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("画像を読み込めませんでした。"));
    reader.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    reader.readAsDataURL(blob);
  });
}

class GuideApiUnavailableError extends Error {}
class GuideNotAvailableError extends Error {}

function createLocalGuideSession(requestBody: GuideRequest): GuideSession {
  const guide = getReferenceGuide(requestBody.fishId, requestBody.preparationId);
  if (!guide) throw new Error("No reference guide is registered for this fish");
  const now = new Date().toISOString();
  return GuideSessionSchema.parse({
    sessionId: crypto.randomUUID(),
    fishId: requestBody.fishId,
    preparationId: requestBody.preparationId,
    guide,
    currentStep: guide.steps[0],
    currentStepIndex: 0,
    completedStepIds: [],
    status: "active",
    source: "public_reference",
    createdAt: now,
    updatedAt: now,
  });
}

function advanceLocalGuideSession(session: GuideSession): GuideSession {
  const nextStepIndex = session.currentStepIndex + 1;
  const completedStepIds = session.currentStep
    ? [...session.completedStepIds, session.currentStep.id]
    : session.completedStepIds;
  return GuideSessionSchema.parse({
    ...session,
    currentStep: session.guide.steps[nextStepIndex] ?? null,
    currentStepIndex: nextStepIndex,
    completedStepIds,
    status: nextStepIndex >= session.guide.steps.length ? "completed" : "active",
    updatedAt: new Date().toISOString(),
  });
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

function fishTeacherDialogue(step?: { id: string; title: string }) {
  if (!step) return "いっしょに確認しよう！";
  if (step.id === "hamachi_scales") return "よーし！うろこ取りだよ！体をぬらして、ヒレの近くもチェック！";
  if (step.id === "tai_scales") return "よーし！うろこ取りだよ！尾側から取って、ヒレの近くも見てね！";
  if (step.id === "other_finfish_identify") return "まず魚の種類を確認しよう！迷ったらお店に聞いてね！";
  return "いい調子！「" + step.title + "」に挑戦だよ！";
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

function HelpButton({ onClick, light = false }: { onClick: () => void; light?: boolean }) {
  return (
    <button
      className={`help-trigger${light ? " is-light" : ""}`}
      type="button"
      aria-label="使い方を開く"
      title="使い方"
      onClick={onClick}
    >
      <span aria-hidden="true">?</span>
    </button>
  );
}

function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      titleRef.current?.focus({ preventScroll: true });
    }
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="help-dialog"
      aria-labelledby="help-dialog-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        dialogRef.current?.close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
    >
      <section className="help-dialog-card">
        <header className="help-dialog-heading">
          <div>
            <h2 ref={titleRef} id="help-dialog-title" tabIndex={-1}>使い方</h2>
          </div>
          <button className="help-dialog-close" type="button" aria-label="ヘルプを閉じる" onClick={() => dialogRef.current?.close()}>
            ×
          </button>
        </header>
        <p className="help-dialog-lead">魚を選び、カメラの横で手順を確認しながら、自分で進めます。</p>

        <ol className="help-flow">
          <li>
            <span>1</span>
            <div><strong>魚を選ぶ</strong><p>21種類から選びます。迷ったら、購入店に確認してください。</p></div>
          </li>
          <li>
            <span>2</span>
            <div><strong>ガイドを始める</strong><p>「俺を捌け！」を押し、画面の案内に沿って横向きにします。</p></div>
          </li>
          <li>
            <span>3</span>
            <div><strong>手順を確認して進む</strong><p>カメラを許可して手順を確認。内容を確かめたら「次の工程へ」を押します。閉じると最初からです。</p></div>
          </li>
        </ol>

        <p className="help-privacy-note">ガイド中、MediaPipeで頭・尾の検知状態が安定して変わると、圧縮した静止画をGoogle Geminiへ自動送信します。連続動画は送らず、画像はアプリに保存しません。Geminiの確認で工程が自動で進むことはありません。</p>
        <footer className="help-dialog-footer">
          <button type="button" onClick={() => dialogRef.current?.close()}>OK</button>
        </footer>
      </section>
    </dialog>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>("select");
  const [helpOpen, setHelpOpen] = useState(false);
  const [category, setCategory] = useState<Category>("よく使う");
  const [search, setSearch] = useState("");
  const [selectedFish, setSelectedFish] = useState("ハマチ");
  const [guideSession, setGuideSession] = useState<GuideSession | null>(null);
  const [guideSessionMode, setGuideSessionMode] = useState<GuideSessionMode>("worker");
  const [guideSessionLoading, setGuideSessionLoading] = useState(false);
  const [guideMessage, setGuideMessage] = useState("");
  const [geminiAnalysis, setGeminiAnalysis] = useState<{
    loading: boolean;
    result?: GuideImageAnalysisResponse;
    error?: boolean;
  }>({ loading: false });
  const [geminiAutoPending, setGeminiAutoPending] = useState(false);
  const [geminiAutoCooldownTick, setGeminiAutoCooldownTick] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const [guideAdvancing, setGuideAdvancing] = useState(false);
  const [activeStep, setActiveStepState] = useState(0);
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
  const [captureNotes, setCaptureNotes] = useState("");
  const [captureRows, setCaptureRows] = useState<CaptureRow[]>([]);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureMessage, setCaptureMessage] = useState("");
  const [captureManifestExported, setCaptureManifestExported] = useState(false);
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | null>(null);
  const [captureLabelsConfirmed, setCaptureLabelsConfirmed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureStartedAt = useRef<number | null>(null);
  const cameraRequestId = useRef(0);
  const guideRequestController = useRef<AbortController | null>(null);
  const guideAdvanceInFlight = useRef(false);
  const geminiAnalysisRequestId = useRef(0);
  const geminiAutoAnalyzerRef = useRef<(() => Promise<boolean>) | null>(null);
  const geminiAutoDetectionWatch = useRef<GeminiAutoDetectionWatch>(createGeminiAutoDetectionWatch());
  const detectionFishName = selectedFish === "その他" ? search.trim() || "ほかの魚" : selectedFish;
  const detectionFishId = screen === "guide" ? resolveGuideFishId(detectionFishName) ?? null : null;
  const headTailDetection = useHeadTailDetection(
    videoRef,
    (screen === "guide" || screen === "capture") && cameraStatus === "active" && cameraStream !== null,
    detectionFishId,
  );

  useEffect(() => {
    if (screen !== "capture") return;
    const visibleParts = new Set(headTailDetection.observation?.detections.map((detection) => detection.label) ?? []);

    if (captureHeadStatusSource !== "manual") {
      const nextStatus = visibleParts.has("head") ? "present_visible" : "unknown";
      const nextSource = visibleParts.has("head") ? "ai_suggestion" : "unknown";
      if (captureHeadStatus !== nextStatus || captureHeadStatusSource !== nextSource) {
        setCaptureHeadStatus(nextStatus);
        setCaptureHeadStatusSource(nextSource);
      }
    }
    if (captureTailStatusSource !== "manual") {
      const nextStatus = visibleParts.has("tail") ? "present_visible" : "unknown";
      const nextSource = visibleParts.has("tail") ? "ai_suggestion" : "unknown";
      if (captureTailStatus !== nextStatus || captureTailStatusSource !== nextSource) {
        setCaptureTailStatus(nextStatus);
        setCaptureTailStatusSource(nextSource);
      }
    }
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
    const updateVisibility = () => setPageVisible(document.visibilityState === "visible");
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    if (screen !== "capture" || (!pendingCapture && (captureRows.length === 0 || captureManifestExported))) return;
    const warnAboutUnsavedLabels = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnAboutUnsavedLabels);
    return () => window.removeEventListener("beforeunload", warnAboutUnsavedLabels);
  }, [captureManifestExported, captureRows.length, pendingCapture, screen]);

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

  const chosenFish = selectedFish === "その他" ? search.trim() || "その他の魚" : selectedFish;
  const selectedFishData = fishList.find((fish) => fish.name === selectedFish);
  const genericFishVisualData = fishList.find((fish) => fish.name === "マグロ");
  const selectedFishVisualData = selectedFishData ?? (selectedFish === "その他" ? genericFishVisualData : undefined);
  const knownGuideFishId = resolveGuideFishId(chosenFish);
  const selectedGuideFishId = knownGuideFishId ?? (selectedFish === "その他" ? "other_finfish" : undefined);
  const stageCaptureSupported = knownGuideFishId !== undefined
    && ["aji", "saba", "tai", "hamachi"].includes(knownGuideFishId);
  const guide = guideSession?.guide;
  const isLastGuideStep = guide ? activeStep >= guide.steps.length - 1 : false;
  const guideIsComplete = guideSession?.status === "completed";
  const currentStep = guide ? guide.steps[activeStep] : undefined;
  const stageTransition = headTailDetection.fishStage.status === "active"
    ? headTailDetection.fishStage.transition
    : null;
  const transitionedFishState = stageTransition ? stageToExpectedFishState(stageTransition.to) : null;
  const suggestedStep = guide && currentStep && !isLastGuideStep
    && transitionedFishState === currentStep.expectedState
    ? guide.steps[activeStep + 1]
    : undefined;
  const fishCanContinue = selectedFish !== "その他" || search.trim().length > 0;

  function setActiveStep(nextStep: number | ((previousStep: number) => number)) {
    geminiAnalysisRequestId.current += 1;
    setActiveStepState(nextStep);
  }

  useEffect(() => {
    geminiAnalysisRequestId.current += 1;
    setGeminiAnalysis({ loading: false });
  }, [currentStep?.id]);

  useEffect(() => {
    const previousWatch = geminiAutoDetectionWatch.current;
    setGeminiAutoPending(false);
    geminiAutoDetectionWatch.current = {
      ...previousWatch,
      pending: false,
      retryCount: 0,
      retryAtMs: 0,
    };
  }, [currentStep?.id]);

  function closeHelp() {
    setHelpOpen(false);
  }

  function startGuide() {
    setScreen("guide");
    setActiveStep(0);
    setGuideSession(null);
    setGuideSessionMode("worker");
    setGuideSessionLoading(false);
    setGuideMessage("");
    setGeminiAnalysis({ loading: false });
    setCameraMessage("");

    guideRequestController.current?.abort();
    const guideController = new AbortController();
    guideRequestController.current = guideController;
    const selectedFishId = selectedGuideFishId;
    if (selectedFishId) {
      setGuideSessionLoading(true);
      const guideRequest = GuideRequestSchema.parse({
        fishId: selectedFishId,
        preparationId: getPreparationIdForFish(selectedFishId),
      });
      void createGuideSession(guideRequest, guideController.signal).then((session) => {
        if (guideController.signal.aborted) return;
        setGuideSession(session);
        setActiveStep(session.currentStepIndex);
      }).catch((error: unknown) => {
        if (!guideController.signal.aborted && error instanceof GuideApiUnavailableError) {
          try {
            const localSession = createLocalGuideSession(guideRequest);
            setGuideSession(localSession);
            setGuideSessionMode("local");
            setActiveStep(localSession.currentStepIndex);
            setGuideMessage("");
          } catch {
            setGuideMessage("魚種別の参考手順を準備できませんでした。魚を選び直してください。");
          }
        } else if (!guideController.signal.aborted && error instanceof GuideNotAvailableError) {
          setGuideMessage(error.message);
        } else if (!guideController.signal.aborted) {
          setGuideMessage("参考手順を読み込めませんでした。通信状態を確認して、魚を選び直してください。");
        }
      }).finally(() => {
        if (!guideController.signal.aborted) setGuideSessionLoading(false);
      });
    } else {
      setGuideMessage(`${chosenFish}の参考手順は未登録です。共通の仮手順には置き換えません。`);
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
    setCaptureLabelsConfirmed(false);
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
    
    captureStartedAt.current = null;
    setScreen("capture");
  }

  function backFromCapture() {
    if (pendingCapture || (captureRows.length > 0 && !captureManifestExported)) {
      const shouldLeave = window.confirm("撮影中の未保存画像、または保存していないCSVラベルがあります。この画面を閉じますか？");
      if (!shouldLeave) return;
    }
    if (pendingCapture) {
      URL.revokeObjectURL(pendingCapture.previewUrl);
      setPendingCapture(null);
    }
    stopCamera();
    setScreen("select");
  }

  async function saveCaptureFrame() {
    if (pendingCapture) return;
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
      const frame = await captureCurrentFrame(video);

      const nextFrameNumber = captureRows.length + 1;
      const frameId = `frame-${String(nextFrameNumber).padStart(4, "0")}`;
      const filename = `${captureSessionId}_${captureFishId}_${frameId}.jpg`;

      const previewUrl = URL.createObjectURL(frame.blob);
      setPendingCapture({
        kind: "head_tail",
        blob: frame.blob,
        previewUrl,
        width: frame.width,
        height: frame.height,
        row: makeCaptureRow(frameId, filename, "needs_review", false),
        activePart: "head",
        headBox: null,
        tailBox: null,
        dragStart: null,
        draftBox: null,
      });
      setCaptureLabelsConfirmed(false);
      setCaptureMessage("撮影画像で頭・尾の正解枠を確認してください。AIの枠は自動では正解にしません。");
    } catch {
      setCaptureMessage("画像を保存できませんでした。ブラウザーのダウンロード許可と空き容量を確認してください。");
    } finally {
      setCaptureBusy(false);
    }
  }

  async function saveStageCaptureFrame() {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth < 1 || video.videoHeight < 1) {
      setCaptureMessage("カメラ映像の準備ができるまで待ってください。");
      return;
    }
    if (!CAPTURE_ID_PATTERN.test(captureSessionId) || !CAPTURE_ID_PATTERN.test(captureFishId)) {
      setCaptureMessage("撮影IDと魚IDは英数字、ピリオド、ハイフン、アンダースコアで入力してください。");
      return;
    }
    if (!stageCaptureSupported) {
      setCaptureMessage("工程モデル用のデータ収集はハマチ・アジ・サバ・タイだけに対応しています。");
      return;
    }
    if (captureStage === "unknown" || captureStage === "other") {
      setCaptureMessage("画像に写っている工程を選んでください。");
      return;
    }
    if (captureRows.length >= MAX_CAPTURE_FRAMES) {
      setCaptureMessage(`1セッションの上限${MAX_CAPTURE_FRAMES}枚に達しました。CSVを保存してください。`);
      return;
    }

    setCaptureBusy(true);
    setCaptureMessage("");
    try {
      const frame = await captureCurrentFrame(video);
      const nextFrameNumber = captureRows.length + 1;
      const frameId = `frame-${String(nextFrameNumber).padStart(4, "0")}`;
      const filename = `${captureSessionId}_${captureFishId}_${frameId}.jpg`;
      const previewUrl = URL.createObjectURL(frame.blob);
      setPendingCapture({
        kind: "stage",
        blob: frame.blob,
        previewUrl,
        width: frame.width,
        height: frame.height,
        row: makeCaptureRow(frameId, filename, "needs_review", true),
        activePart: "head",
        headBox: null,
        tailBox: null,
        dragStart: null,
        draftBox: null,
      });
      setCaptureLabelsConfirmed(false);
      setCaptureMessage("撮影画像を確認し、選択した工程と一致している場合に保存してください。");
    } catch {
      setCaptureMessage("画像を保存できませんでした。ブラウザーのダウンロード許可と空き容量を確認してください。");
    } finally {
      setCaptureBusy(false);
    }
  }

  async function captureCurrentFrame(video: HTMLVideoElement): Promise<{ blob: Blob; width: number; height: number }> {
    const scale = Math.min(1, MAX_CAPTURE_FRAME_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("2D canvas is unavailable");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not encode capture frame")), "image/jpeg", 0.88);
    });
    return { blob, width: canvas.width, height: canvas.height };
  }

  function makeCaptureRow(frameId: string, filename: string, reviewStatus: CaptureRow["review_status"], stageOnly: boolean): CaptureRow {
    return {
      fish_species: chosenFish,
      session_id: captureSessionId,
      fish_id: captureFishId,
      frame_id: frameId,
      relative_time_ms: Math.max(0, Math.round(performance.now() - (captureStartedAt.current ?? performance.now()))),
      frame_path: filename,
      confirmed_stage: captureStage,
      head_status: stageOnly ? "unknown" : captureHeadStatus,
      head_status_source: stageOnly ? "unknown" : captureHeadStatusSource,
      tail_status: stageOnly ? "unknown" : captureTailStatus,
      tail_status_source: stageOnly ? "unknown" : captureTailStatusSource,
      hands_visible: stageOnly ? "unknown" : captureHandsVisible,
      knife_visible: stageOnly ? "unknown" : captureKnifeVisible,
      occlusion: stageOnly ? "unknown" : captureOcclusion,
      device_model: stageOnly ? "unknown" : captureDeviceModel.trim() || "unknown",
      camera_view: stageOnly ? "unknown" : captureCameraView,
      lighting: stageOnly ? "unknown" : captureLighting,
      review_status: reviewStatus,
      notes: stageOnly ? "" : captureNotes.trim(),
      ai_status: stageOnly ? "idle" : headTailDetection.status,
      ai_observation_json: stageOnly || !headTailDetection.observation ? "" : JSON.stringify(headTailDetection.observation),
      head_bbox_x: "",
      head_bbox_y: "",
      head_bbox_width: "",
      head_bbox_height: "",
      head_bbox_source: "unknown",
      tail_bbox_x: "",
      tail_bbox_y: "",
      tail_bbox_width: "",
      tail_bbox_height: "",
      tail_bbox_source: "unknown",
    };
  }

  function captureStageName(stage: CaptureStage): string {
    if (stage === "unknown") return "不明";
    if (stage === "other") return "その他";
    return fishStageLabel(stage);
  }

  function annotationPoint(event: ReactPointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  function annotationPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!pendingCapture) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = annotationPoint(event);
    setPendingCapture((current) => current ? {
      ...current,
      dragStart: point,
      draftBox: { x: point.x, y: point.y, width: 0, height: 0 },
    } : current);
  }

  function annotationPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!pendingCapture?.dragStart) return;
    const point = annotationPoint(event);
    const start = pendingCapture.dragStart;
    setPendingCapture((current) => current ? {
      ...current,
      draftBox: {
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      },
    } : current);
  }

  function finishAnnotationPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (!pendingCapture?.dragStart) return;
    const point = annotationPoint(event);
    const start = pendingCapture.dragStart;
    const box = {
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    };
    const normalizedBox = box.width >= 0.005 && box.height >= 0.005 ? box : null;
    setPendingCapture((current) => current ? {
      ...current,
      dragStart: null,
      draftBox: null,
      headBox: current.activePart === "head" && normalizedBox ? normalizedBox : current.headBox,
      tailBox: current.activePart === "tail" && normalizedBox ? normalizedBox : current.tailBox,
    } : current);
  }

  function cancelAnnotationPointer() {
    setPendingCapture((current) => current ? { ...current, dragStart: null, draftBox: null } : current);
  }

  function clearAnnotation(part: CapturePart) {
    setPendingCapture((current) => current ? {
      ...current,
      headBox: part === "head" ? null : current.headBox,
      tailBox: part === "tail" ? null : current.tailBox,
    } : current);
  }

  function normalizedBoxColumns(box: CaptureBox | null) {
    if (!box) return { x: "", y: "", width: "", height: "", source: "unknown" as const };
    return {
      x: box.x.toFixed(6),
      y: box.y.toFixed(6),
      width: box.width.toFixed(6),
      height: box.height.toFixed(6),
      source: "manual" as const,
    };
  }

  function confirmPendingCapture() {
    if (!pendingCapture) return;
    let row: CaptureRow;
    if (pendingCapture.kind === "stage") {
      row = { ...pendingCapture.row, review_status: captureLabelsConfirmed ? "reviewed" : "needs_review" };
    } else {
      const head = normalizedBoxColumns(pendingCapture.headBox);
      const tail = normalizedBoxColumns(pendingCapture.tailBox);
      row = {
        ...pendingCapture.row,
        review_status: captureLabelsConfirmed ? "reviewed" : "needs_review",
        head_status_source: captureLabelsConfirmed ? "manual" : pendingCapture.row.head_status_source,
        tail_status_source: captureLabelsConfirmed ? "manual" : pendingCapture.row.tail_status_source,
        head_bbox_x: head.x,
        head_bbox_y: head.y,
        head_bbox_width: head.width,
        head_bbox_height: head.height,
        head_bbox_source: head.source,
        tail_bbox_x: tail.x,
        tail_bbox_y: tail.y,
        tail_bbox_width: tail.width,
        tail_bbox_height: tail.height,
        tail_bbox_source: tail.source,
      };
    }
    downloadCaptureFile(pendingCapture.blob, row.frame_path);
    setCaptureRows((rows) => [...rows, row]);
    setCaptureManifestExported(false);
    setCaptureLabelsConfirmed(false);
    setCaptureMessage(pendingCapture.kind === "stage"
      ? `${row.frame_path} を保存しました。工程を記録し、頭・尾など別の項目は不明のままにしました。`
      : `${row.frame_path} を保存しました。枠は人の確認ラベルとしてCSVに記録しました。`);
    URL.revokeObjectURL(pendingCapture.previewUrl);
    setPendingCapture(null);
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
    if (!guideSession || !guide) return;
    const nextIndex = Math.min(guide.steps.length - 1, activeStep + 1);
    if (guideAdvanceInFlight.current) return;

    if (guideSession?.status === "completed") {
      if (nextIndex !== activeStep) {
        setActiveStep(nextIndex);
        setGuideMessage("");
      }
      return;
    }

    // The session API is authoritative. A locally selected earlier step can be
    // revisited; moving back to the server's current step stays local, and only
    // the next server step is submitted once the UI catches up.
    if (activeStep < guideSession.currentStepIndex || activeStep > guideSession.currentStepIndex) {
      if (nextIndex !== activeStep) setActiveStep(nextIndex);
      return;
    }

    if (guideSessionMode === "local") {
      const session = advanceLocalGuideSession(guideSession);
      if (session.status === "completed") {
        setGuideSession(session);
        setActiveStep(session.currentStepIndex);
        setGuideMessage("");
        stopCamera();
        return;
      }
      setGuideSession(session);
      setActiveStep(Math.min(session.currentStepIndex, session.guide.steps.length - 1));
      setGuideMessage("");
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
      if (session.status === "completed") {
        setGuideSession(session);
        setActiveStep(session.currentStepIndex);
        setGuideMessage("");
        stopCamera();
        return;
      }
      setGuideSession(session);
      setActiveStep(Math.min(session.currentStepIndex, session.guide.steps.length - 1));
      setGuideMessage("");
    } catch {
      if (!signal.aborted) setGuideMessage("工程を更新できませんでした。現在の手順を確認して、もう一度お試しください。");
    } finally {
      guideAdvanceInFlight.current = false;
      setGuideAdvancing(false);
    }
  }

  async function analyzeCurrentCameraImage(): Promise<boolean> {
    if (geminiAnalysis.loading || guideAdvancing || guideSessionLoading) return false;
    if (!guideSession || !currentStep || !selectedGuideFishId || !videoRef.current || cameraStatus !== "active") return false;

    const signal = guideRequestController.current?.signal;
    if (!signal || signal.aborted) return false;

    const requestId = ++geminiAnalysisRequestId.current;
    setGeminiAnalysis({ loading: true });
    try {
      const frame = await captureCurrentFrame(videoRef.current);
      if (signal.aborted || requestId !== geminiAnalysisRequestId.current) return false;
      const imageData = await blobToDataUrl(frame.blob);
      if (signal.aborted || requestId !== geminiAnalysisRequestId.current) return false;
      geminiAutoDetectionWatch.current.lastTriggeredAt = Date.now();
      const result = await analyzeGuideImage({ fishId: selectedGuideFishId, stepId: currentStep.id, imageData }, signal);
      if (signal.aborted || requestId !== geminiAnalysisRequestId.current) return false;
      setGeminiAnalysis({ loading: false, result });
      return true;
    } catch {
      if (!signal.aborted && requestId === geminiAnalysisRequestId.current) setGeminiAnalysis({ loading: false, error: true });
      return false;
    }
  }

  useEffect(() => {
    geminiAutoAnalyzerRef.current = () => analyzeCurrentCameraImage();
  });

  useEffect(() => {
    const watch = geminiAutoDetectionWatch.current;
    if (screen !== "guide" || cameraStatus !== "active" || !cameraStream || !guideSession
      || guideSessionMode !== "worker" || guideSession.status === "completed" || guideIsComplete) {
      geminiAutoDetectionWatch.current = createGeminiAutoDetectionWatch();
      if (watch.pending) setGeminiAutoPending(false);
      return;
    }

    if (!pageVisible) {
      watch.lastObservationAt = null;
      watch.candidateSignature = null;
      watch.candidateCount = 0;
      watch.candidateCapturedAtMs = null;
    }
  }, [pageVisible, screen, cameraStatus, cameraStream, guideSession?.sessionId, guideSession?.status, guideSessionMode, guideIsComplete]);

  useEffect(() => {
    const watch = geminiAutoDetectionWatch.current;
    const observation = headTailDetection.observation;
    const active = pageVisible
      && screen === "guide"
      && cameraStatus === "active"
      && cameraStream !== null
      && guideSession !== null
      && guideSessionMode === "worker"
      && guideSession.status !== "completed"
      && !guideIsComplete
      && headTailDetection.status === "active"
      && observation?.source === "mediapipe";

    const resetCandidate = () => {
      watch.lastObservationAt = null;
      watch.candidateSignature = null;
      watch.candidateCount = 0;
      watch.candidateCapturedAtMs = null;
    };

    if (!active || !observation) {
      resetCandidate();
      return;
    }
    if (watch.lastObservationAt === observation.capturedAt) return;

    const capturedAtMs = Date.parse(observation.capturedAt);
    const now = Date.now();
    if (!Number.isFinite(capturedAtMs) || capturedAtMs > now || now - capturedAtMs > GEMINI_AUTO_MAX_OBSERVATION_AGE_MS) {
      resetCandidate();
      return;
    }

    const signature = (currentStep?.id ?? "no-step") + ":" + ["head", "tail"]
      .filter((label) => observation.detections.some((detection) => detection.label === label))
      .join(",");
    const continuousCandidate = watch.candidateSignature === signature
      && watch.candidateCapturedAtMs !== null
      && capturedAtMs > watch.candidateCapturedAtMs
      && capturedAtMs - watch.candidateCapturedAtMs <= GEMINI_AUTO_MAX_FRAME_GAP_MS;

    watch.lastObservationAt = observation.capturedAt;
    watch.candidateSignature = signature;
    watch.candidateCount = continuousCandidate ? watch.candidateCount + 1 : 1;
    watch.candidateCapturedAtMs = capturedAtMs;

    if (watch.candidateCount < GEMINI_AUTO_STABLE_OBSERVATIONS || watch.stableSignature === signature) return;

    watch.stableSignature = signature;

    if (watch.retryAtMs > 0) setGeminiAutoCooldownTick((tick) => tick + 1);
    watch.retryCount = 0;
    watch.retryAtMs = 0;

    watch.pending = true;
    setGeminiAutoPending(true);
  }, [
    pageVisible,
    screen,
    cameraStatus,
    cameraStream,
    guideSession?.sessionId,
    guideSession?.status,
    guideSessionMode,
    guideIsComplete,
    headTailDetection.status,
    headTailDetection.observation,
  ]);

  useEffect(() => {
    if (!geminiAutoPending || !pageVisible) return;
    if (screen !== "guide" || cameraStatus !== "active" || !cameraStream || !guideSession
      || guideSessionMode !== "worker" || guideSession.status === "completed" || guideIsComplete
      || headTailDetection.status !== "active" || geminiAnalysis.loading || guideSessionLoading || guideAdvancing) return;

    const watch = geminiAutoDetectionWatch.current;
    const nextEligibleAt = Math.max(
      watch.lastTriggeredAt + GEMINI_AUTO_MIN_INTERVAL_MS,
      watch.retryAtMs,
    );
    const cooldownRemaining = nextEligibleAt - Date.now();
    if (cooldownRemaining > 0) {
      const timerId = window.setTimeout(
        () => setGeminiAutoCooldownTick((tick) => tick + 1),
        cooldownRemaining,
      );
      return () => window.clearTimeout(timerId);
    }

    watch.pending = false;
    watch.lastTriggeredAt = Date.now();
    watch.retryAtMs = 0;
    setGeminiAutoPending(false);
    void (async () => {
      const succeeded = (await geminiAutoAnalyzerRef.current?.()) ?? false;
      if (geminiAutoDetectionWatch.current !== watch) return;

      if (succeeded) {
        watch.retryCount = 0;
        watch.retryAtMs = 0;
        return;
      }

      // A newer stable detection is already queued; let it use the next eligible frame.
      if (watch.pending) {
        watch.retryCount = 0;
        watch.retryAtMs = 0;
        return;
      }

      const retryDelayMs = GEMINI_AUTO_RETRY_DELAYS_MS[watch.retryCount];
      if (retryDelayMs === undefined) return;

      watch.retryCount += 1;
      watch.retryAtMs = Date.now() + retryDelayMs;
      watch.pending = true;
      setGeminiAutoPending(true);
    })();
  }, [
    geminiAutoPending,
    geminiAutoCooldownTick,
    pageVisible,
    screen,
    cameraStatus,
    cameraStream,
    guideSession?.sessionId,
    guideSession?.status,
    guideSessionMode,
    guideIsComplete,
    headTailDetection.status,
    geminiAnalysis.loading,
    guideSessionLoading,
    guideAdvancing,
  ]);

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
  const guideDetectionStatus = (() => {
    if (cameraStatus === "denied" || cameraStatus === "unavailable" || cameraStatus === "error") return "カメラを使えないため自動確認は停止中";
    if (!cameraStream || cameraStatus !== "active") return "カメラを起動すると自動で確認するよ";
    if (guideSessionMode === "local") return "APIに接続できず自動確認は停止中";
    if (guideSessionLoading) return "ガイドを準備中";
    if (headTailDetection.status === "loading") return "認識モデルを準備中";
    if (headTailDetection.status === "paused") return "画面が隠れている間は認識を一時停止";
    if (headTailDetection.status === "unavailable" || headTailDetection.status === "error") return "認識モデルを起動できないみたい";
    if (geminiAnalysis.loading) return "Geminiで映像を確認中";
    if (geminiAnalysis.error) return "Gemini確認に失敗したよ";
    if (geminiAnalysis.result) {
      if (geminiAnalysis.result.certainty === "uncertain") return "Gemini: 映像だけでは判断できなかったよ";
      const names = { head: "頭", body: "体", tail: "尾" };
      const parts = geminiAnalysis.result.visibleParts.map((part) => names[part]);
      return parts.length > 0 ? "Gemini: " + parts.join("・") + "が見えているよ" : "Gemini: 見える部位を確認できなかったよ";
    }
    if (headTailDetection.observation?.detections.length) {
      const labels = [...new Set(headTailDetection.observation.detections.map((detection) => detection.label))]
        .map((label) => label === "head" ? "頭" : "尾");
      return "MediaPipe: " + labels.join("・") + "を検知中";
    }
    if (headTailDetection.status === "active") return "MediaPipe: 頭・尾を探しているよ";
    return "自動確認を準備中";
  })();
  const guideDetectionStatusState = geminiAnalysis.loading
    ? "loading"
    : geminiAnalysis.error || headTailDetection.status === "error" || headTailDetection.status === "unavailable"
      ? "error"
      : geminiAnalysis.result
        ? geminiAnalysis.result.certainty
        : headTailDetection.status;
  return (
    <main className={`app-root ${screen === "guide" ? "is-guide" : screen === "capture" ? "is-capture" : ""}`}>
      {screen === "select" ? (
        <section className="selector-screen" aria-label="魚を選ぶ">
          <header className="hero">
            <div className="hero-copy">
              <h1>俺を捌け！</h1>
              <p className="hero-intro">魚を選んで、手順を見よう</p>
            </div>
            <HelpButton onClick={() => setHelpOpen(true)} />
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
                  <span className="fish-card-image-frame" aria-hidden="true">
                    {genericFishVisualData ? (
                      <img className={fishImageClass("fish-card-photo")} src={fishImage(genericFishVisualData)} alt="" loading="lazy" />
                    ) : <FishMark />}
                  </span>
                  <div className="fish-card-copy"><strong>その他の魚</strong></div>
                </button>
              ) : null}
              {matchingFish.length === 0 && search ? (
                <button type="button" className={`fish-card fish-card--other${selectedFish === "その他" ? " is-selected" : ""}`} onClick={() => setSelectedFish("その他")} aria-pressed={selectedFish === "その他"}>
                  <span className="fish-card-image-frame" aria-hidden="true">
                    {genericFishVisualData ? (
                      <img className={fishImageClass("fish-card-photo")} src={fishImage(genericFishVisualData)} alt="" loading="lazy" />
                    ) : <FishMark />}
                  </span>
                  <div className="fish-card-copy"><strong>「{search}」で進む</strong></div>
                </button>
              ) : null}
              {matchingFish.length === 0 && !search ? <p className="empty-fish">このカテゴリの魚は準備中です。</p> : null}
            </div>

            <button className="start-button" type="button" onClick={() => void startGuide()}>
              <strong>俺を捌け！</strong>
              <span>{selectedGuideFishId === "other_finfish" ? "基本の三枚おろしで進む" : selectedGuideFishId ? "この魚を捌く" : "この魚の手順は準備中"}</span>
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
            <HelpButton light onClick={() => setHelpOpen(true)} />
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
                <button type="button" onClick={() => void saveCaptureFrame()} disabled={cameraStatus !== "active" || captureBusy || pendingCapture !== null || captureRows.length >= MAX_CAPTURE_FRAMES}>
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
                <label className="capture-field"><span>確認した工程</span><select value={captureStage} onChange={(event) => { setCaptureStage(event.currentTarget.value as CaptureStage);  }}>
                  <option value="unknown">未確認</option><option value="whole">未処理</option><option value="head_removed">頭を外した</option><option value="gutted">内臓処理済み</option><option value="filleting">身を分けている途中</option><option value="finished">工程完了</option><option value="other">その他</option>
                </select></label>
                <label className="capture-field"><span>頭の状態{captureHeadStatusSource === "ai_suggestion" ? " · AI仮入力" : ""}</span><select value={captureHeadStatus} onChange={(event) => { setCaptureHeadStatus(event.currentTarget.value as PartVisibility); setCaptureHeadStatusSource("manual");  }}>
                  <option value="unknown">未確認</option><option value="present_visible">付いている・見える</option><option value="removed_confirmed">切除済みと確認</option><option value="occluded">遮蔽されている</option><option value="out_of_frame">画角外</option>
                </select></label>
                <label className="capture-field"><span>尾の状態{captureTailStatusSource === "ai_suggestion" ? " · AI仮入力" : ""}</span><select value={captureTailStatus} onChange={(event) => { setCaptureTailStatus(event.currentTarget.value as PartVisibility); setCaptureTailStatusSource("manual");  }}>
                  <option value="unknown">未確認</option><option value="present_visible">付いている・見える</option><option value="removed_confirmed">切除済みと確認</option><option value="occluded">遮蔽されている</option><option value="out_of_frame">画角外</option>
                </select></label>
                <label className="capture-field"><span>遮蔽の主な理由</span><select value={captureOcclusion} onChange={(event) => { setCaptureOcclusion(event.currentTarget.value);  }}>
                  <option value="unknown">不明</option><option value="none">なし</option><option value="hands">手</option><option value="knife">包丁</option><option value="container">容器・器具</option><option value="overlap">魚や物との重なり</option><option value="other">その他</option>
                </select></label>
                <label className="capture-field"><span>カメラ角度</span><select value={captureCameraView} onChange={(event) => { setCaptureCameraView(event.currentTarget.value);  }}>
                  <option value="unknown">不明</option><option value="overhead">真上</option><option value="oblique">斜め上</option><option value="side">横</option><option value="other">その他</option>
                </select></label>
                <label className="capture-field"><span>照明</span><select value={captureLighting} onChange={(event) => { setCaptureLighting(event.currentTarget.value);  }}>
                  <option value="unknown">不明</option><option value="daylight">自然光</option><option value="indoor-led">室内LED</option><option value="dim">暗め</option><option value="other">その他</option>
                </select></label>
                <label className="capture-field"><span>端末機種（任意）</span><input value={captureDeviceModel} onChange={(event) => { setCaptureDeviceModel(event.currentTarget.value);  }} maxLength={120} placeholder="不明（任意）" /></label>
              </div>

              <button className="capture-export-button" type="button" onClick={() => void saveStageCaptureFrame()} disabled={!stageCaptureSupported || cameraStatus !== "active" || captureBusy || captureRows.length >= MAX_CAPTURE_FRAMES || captureStage === "unknown" || captureStage === "other"}>
                {captureBusy ? "保存中…" : "工程画像を保存（頭・尾の枠なし）"}
              </button>
              <p className="capture-label-hint">{stageCaptureSupported ? "工程分類のデータを集める場合はこちら。画像と工程ラベルが一致するか保存前に確認し、ほかの項目は「不明」で記録します。" : "工程分類用の撮影はハマチ・アジ・サバ・タイが対象です。魚種別ガイドは利用できます。"}</p>
              <div className="capture-field-grid capture-presence-grid">
                <label className="capture-field"><span>手の映り込み</span><select value={captureHandsVisible} onChange={(event) => { setCaptureHandsVisible(event.currentTarget.value as PresenceStatus);  }}><option value="unknown">不明</option><option value="true">映っている</option><option value="false">映っていない</option></select></label>
                <label className="capture-field"><span>包丁の映り込み</span><select value={captureKnifeVisible} onChange={(event) => { setCaptureKnifeVisible(event.currentTarget.value as PresenceStatus);  }}><option value="unknown">不明</option><option value="true">映っている</option><option value="false">映っていない</option></select></label>
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
          {pendingCapture ? (
            <div className="capture-annotation-backdrop">
              <section className="capture-annotation-dialog" role="dialog" aria-modal="true" aria-labelledby="capture-annotation-title">
                <header className="capture-annotation-heading">
                  <div><span>人手の正解ラベル</span><h2 id="capture-annotation-title">{pendingCapture.kind === "stage" ? "工程画像を確認" : "頭・尾の枠を確認"}</h2></div>
                  <button type="button" onClick={backFromCapture} aria-label="撮影画面を閉じる">×</button>
                </header>
                <p>{pendingCapture.kind === "stage"
                  ? `選択した工程「${captureStageName(pendingCapture.row.confirmed_stage)}」と画像が一致しているか確認します。頭・尾などほかの状態は不明として記録します。`
                  : "画像上をドラッグして枠を描きます。AIの候補は別に保存済みで、ここには自動コピーされません。該当部位が見えない場合は枠を付けず、状態ラベルを「遮蔽・画角外・未確認」から選んでください。"}</p>
                {pendingCapture.kind === "head_tail" ? (
                  <div className="capture-annotation-tools">
                    <button type="button" className={pendingCapture.activePart === "head" ? "is-active" : ""} onClick={() => setPendingCapture((current) => current ? { ...current, activePart: "head" } : current)}>頭の枠 {pendingCapture.headBox ? "✓" : "未設定"}</button>
                    <button type="button" className={pendingCapture.activePart === "tail" ? "is-active" : ""} onClick={() => setPendingCapture((current) => current ? { ...current, activePart: "tail" } : current)}>尾の枠 {pendingCapture.tailBox ? "✓" : "未設定"}</button>
                    <button type="button" onClick={() => clearAnnotation("head")} disabled={!pendingCapture.headBox}>頭を消す</button>
                    <button type="button" onClick={() => clearAnnotation("tail")} disabled={!pendingCapture.tailBox}>尾を消す</button>
                  </div>
                ) : null}
                <div className="capture-annotation-canvas-wrap">
                  {pendingCapture.kind === "stage" ? (
                    <img className="capture-annotation-image is-preview-only" src={pendingCapture.previewUrl} alt="工程を確認する撮影画像" />
                  ) : <svg
                    className="capture-annotation-image"
                    viewBox={`0 0 ${pendingCapture.width} ${pendingCapture.height}`}
                    width={pendingCapture.width}
                    height={pendingCapture.height}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label="撮影画像。選択した頭または尾の部分をドラッグして囲みます。"
                    onPointerDown={annotationPointerDown}
                    onPointerMove={annotationPointerMove}
                    onPointerUp={finishAnnotationPointer}
                    onPointerCancel={cancelAnnotationPointer}
                  >
                    <image href={pendingCapture.previewUrl} x="0" y="0" width={pendingCapture.width} height={pendingCapture.height} />
                    {pendingCapture.headBox ? <rect className="capture-box-head" x={pendingCapture.headBox.x * pendingCapture.width} y={pendingCapture.headBox.y * pendingCapture.height} width={pendingCapture.headBox.width * pendingCapture.width} height={pendingCapture.headBox.height * pendingCapture.height} /> : null}
                    {pendingCapture.tailBox ? <rect className="capture-box-tail" x={pendingCapture.tailBox.x * pendingCapture.width} y={pendingCapture.tailBox.y * pendingCapture.height} width={pendingCapture.tailBox.width * pendingCapture.width} height={pendingCapture.tailBox.height * pendingCapture.height} /> : null}
                    {pendingCapture.draftBox ? <rect className={`capture-box-draft is-${pendingCapture.activePart}`} x={pendingCapture.draftBox.x * pendingCapture.width} y={pendingCapture.draftBox.y * pendingCapture.height} width={pendingCapture.draftBox.width * pendingCapture.width} height={pendingCapture.draftBox.height * pendingCapture.height} /> : null}
                  </svg>}
                </div>
                <label className="capture-annotation-confirm"><input type="checkbox" checked={captureLabelsConfirmed} onChange={(event) => setCaptureLabelsConfirmed(event.currentTarget.checked)} />{pendingCapture.kind === "stage" ? "画像と選択した工程ラベルが一致している" : "この画像を見て、工程・頭尾の状態ラベルを確認した（AI候補を採用する場合も人が確認）"}</label>
                <footer className="capture-annotation-actions">
                  <button type="button" onClick={() => {
                    URL.revokeObjectURL(pendingCapture.previewUrl);
                    setPendingCapture(null);
                    setCaptureMessage("撮影画像の保存を取り消しました。");
                  }}>この画像を破棄</button>
                  <button type="button" className="is-primary" onClick={confirmPendingCapture}>{pendingCapture.kind === "stage" ? captureLabelsConfirmed ? "工程ラベルを確認して保存" : "未確認で保存" : captureLabelsConfirmed ? "確認済みとして保存" : "未確認として保存"}</button>
                </footer>
              </section>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="guide-screen" aria-label={`${chosenFish}のさばきガイド`}>
          <div className="orientation-screen">
            <div className="orientation-top">
              <button className="orientation-back" type="button" onClick={backToFishSelection} aria-label="魚の選択に戻る">
                <span aria-hidden="true">←</span><span>魚の選択に戻る</span>
              </button>
              <strong>俺を捌け！</strong>
              <HelpButton onClick={() => setHelpOpen(true)} />
            </div>
            <div className="orientation-main">
              <RotatePhoneIcon />
              <h1>画面を横に<br />してください</h1>
            </div>
            {cameraMessage ? <p className="orientation-message" role="status">{cameraMessage}</p> : null}
          </div>

          <div className="landscape-screen">
            <header className="guide-header">
              <button className="back-link" type="button" onClick={backToFishSelection} aria-label="魚の選択に戻る">
                <span aria-hidden="true">←</span><span className="back-link-label">魚の選択に戻る</span>
              </button>
              <div className="guide-brand"><strong>{chosenFish}先生のさばきガイド</strong></div>
              {guideSession ? (
                <div className="guide-header-progress" aria-label={guideIsComplete ? "ガイド完了" : `工程 ${activeStep + 1} / ${guideSession.guide.steps.length}`}>
                  <strong>{guideIsComplete ? "ガイド完了" : `STEP ${activeStep + 1} / ${guideSession.guide.steps.length}`}</strong>
                  <div className="guide-progress" aria-hidden="true">
                    {guideSession.guide.steps.map((step, index) => <span key={step.id} className={index <= activeStep ? "is-active" : ""} />)}
                  </div>
                </div>
              ) : <span className="guide-status-label">{guideSessionLoading ? "手順を準備中…" : guideMessage ? "読み込みエラー" : "手順未登録"}</span>}
              <HelpButton onClick={() => setHelpOpen(true)} />
            </header>

            <div className="guide-layout">
              <div className="guide-stage">
                <section className="camera-card" aria-label="カメラプレビュー">
                  <div className="camera-topline"><span>カメラプレビュー</span></div>
                  <div className="guide-fish-bubble" aria-live="polite">
                    <span className="guide-fish-bubble-copy">{fishTeacherDialogue(currentStep)}</span>
                    <small className="guide-fish-bubble-status" data-state={guideDetectionStatusState} role="status">{guideDetectionStatus}</small>
                  </div>
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

              </div>

              <aside className="guide-panel">
                {currentStep ? (
                  <div className="guide-step" aria-live="polite">
                    <h2>{currentStep.title}</h2>
                    <p>{currentStep.description}</p>
                    {guideMessage ? <p className="guide-message" role="status">{guideMessage}</p> : null}
                  </div>
                ) : (
                  <div className="guide-step guide-empty-state" aria-live="polite">
                    <h2>{guideSessionLoading ? "参考手順を準備中" : guideIsComplete ? "ガイド完了" : "この魚の手順は未登録です"}</h2>
                    <p>{guideIsComplete ? "この魚のガイドはここまでです。次の調理や加工はガイド対象外です。" : guideMessage || "公開資料を確認した魚種から順に追加しています。共通の仮手順を魚種別ガイドとして表示することはありません。"}</p>
                  </div>
                )}
                {suggestedStep && stageTransition ? (
                  <section className="guide-stage-suggestion" aria-live="polite">
                    <span>工程変化を検知：{fishStageLabel(stageTransition.to)}</span>
                    <strong>次の案内候補「{suggestedStep.title}」</strong>
                    <p>{suggestedStep.description}</p>
                    <small>状態判定は提案です。魚と手元を確認してから「次の工程へ」を押してください。</small>
                  </section>
                ) : null}
                {!guideIsComplete ? (
                  <div className="guide-actions">
                    <div className="guide-controls">
                      <button type="button" onClick={() => { setActiveStep((step) => Math.max(0, step - 1)); setGuideMessage(""); }} disabled={!guideSession || activeStep === 0}>戻る</button>
                      <button type="button" onClick={() => void advanceStep()} disabled={!guideSession || guideSessionLoading || guideAdvancing || (isLastGuideStep && guideIsComplete)}>{guideSessionLoading ? "準備中…" : guideAdvancing ? "更新中…" : isLastGuideStep ? "ガイドを完了" : "次の工程へ"} <span>→</span></button>
                    </div>
                  </div>
                ) : null}
              </aside>
            </div>
          </div>
        </section>
      )}
      <HelpDialog open={helpOpen} onClose={closeHelp} />
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
