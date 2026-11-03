import { useEffect, useState, type RefObject } from "react";
import { ObservationSchema, type GuideRequest, type Observation } from "@orewosabake/contracts";
import type { HeadTailWorkerRequest, HeadTailWorkerResponse } from "../model/headTailWorkerProtocol";
import { fishStageLabel, parseFishStage, type FishStage, type FishStageTransition } from "../model/fishStage";

export type HeadTailDetectionStatus = "idle" | "loading" | "active" | "paused" | "unavailable" | "error";

export type HeadTailDetection = {
  status: HeadTailDetectionStatus;
  message: string;
  observation: Observation | null;
  fishStage: FishStageDetection;
};

export type FishStageDetectionStatus = "idle" | "loading" | "active" | "paused" | "unavailable" | "uncertain" | "error";
export type FishStageDetection = {
  status: FishStageDetectionStatus;
  message: string;
  stage: FishStage | null;
  score: number | null;
  transition: FishStageTransition | null;
};

const MODEL_PATH = "/models/head-tail.tflite";
const WASM_PATH = "/mediapipe/wasm";
const INFERENCE_INTERVAL_MS = 1_000;
const INFERENCE_TIMEOUT_MS = 15_000;
const INITIALIZATION_TIMEOUT_MS = 90_000;
const MAX_OBSERVATION_AGE_MS = 2_000;
const MAX_FRAME_DIMENSION = 832;
const FISH_STAGE_MIN_SCORE = 0.7;
const FISH_STAGE_STABLE_FRAMES = 3;
const FISH_STAGE_MAX_FRAME_GAP_MS = 2_500;
const FISH_STAGE_TRANSITION_NOTICE_MS = 30_000;
const MEDIAPIPE_RUNTIME_ASSETS = [
  `${WASM_PATH}/vision_wasm_internal.js`,
  `${WASM_PATH}/vision_wasm_internal.wasm`,
  `${WASM_PATH}/vision_wasm_nosimd_internal.js`,
  `${WASM_PATH}/vision_wasm_nosimd_internal.wasm`,
];

const IDLE_MESSAGE = "カメラ起動後に認識モデルを確認します。";
const ACTIVE_MESSAGE = "頭・尾を1秒ごとに端末内で確認しています。";
const PAUSED_MESSAGE = "画面が非表示のため認識を一時停止しています。";
const ERROR_MESSAGE = "認識処理に失敗しました。カメラを再起動してください。";
const STAGE_IDLE: FishStageDetection = {
  status: "idle",
  message: "カメラ起動後に工程の変化を確認します。",
  stage: null,
  score: null,
  transition: null,
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240) || "原因を特定できませんでした。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkerResponse(value: unknown): value is HeadTailWorkerResponse {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "ready") {
    return (value.fishStageStatus === "ready" || value.fishStageStatus === "unavailable" || value.fishStageStatus === "error")
      && typeof value.fishStageMessage === "string";
  }
  if (value.type === "result") {
    const prediction = value.fishStagePrediction;
    const validPrediction = prediction === undefined || prediction === null || (
      isRecord(prediction)
      && typeof prediction.label === "string"
      && typeof prediction.score === "number"
      && typeof prediction.capturedAt === "string"
    );
    return "observation" in value
      && validPrediction
      && (value.fishStageError === undefined || typeof value.fishStageError === "string");
  }
  return value.type === "error" && typeof value.message === "string";
}

function waitForWorkerReady(
  worker: Worker,
  signal: AbortSignal,
  request: Extract<HeadTailWorkerRequest, { type: "initialize" }>,
): Promise<Extract<HeadTailWorkerResponse, { type: "ready" }>> {
  return new Promise((resolve, reject) => {
    let timeoutId: number | undefined;
    let settled = false;

    const cleanup = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      signal.removeEventListener("abort", handleAbort);
    };
    const finish = (error?: Error, response?: Extract<HeadTailWorkerResponse, { type: "ready" }>) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new Error("The inference worker returned no initialization result"));
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (!isWorkerResponse(event.data)) {
        finish(new Error("The inference worker returned an invalid initialization response"));
      } else if (event.data.type === "ready") {
        finish(undefined, event.data);
      } else if (event.data.type === "error") {
        finish(new Error(event.data.message));
      }
    };
    const handleError = (event: ErrorEvent) => finish(new Error(event.message || "認識Workerを起動できませんでした。"));
    const handleAbort = () => finish(new Error("The inference worker initialization was cancelled"));

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    signal.addEventListener("abort", handleAbort, { once: true });
    timeoutId = window.setTimeout(
      () => finish(new Error("認識モデルの初期化が90秒でタイムアウトしました。通信状態を確認して再起動してください。")),
      INITIALIZATION_TIMEOUT_MS,
    );

    if (signal.aborted) {
      handleAbort();
      return;
    }

    worker.postMessage(request);
  });
}

export function useHeadTailDetection(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  fishId: GuideRequest["fishId"] | null,
): HeadTailDetection {
  const [detection, setDetection] = useState<HeadTailDetection>({
    status: "idle",
    message: IDLE_MESSAGE,
    observation: null,
    fishStage: STAGE_IDLE,
  });

  useEffect(() => {
    if (!enabled) {
      setDetection({ status: "idle", message: IDLE_MESSAGE, observation: null, fishStage: STAGE_IDLE });
      return;
    }

    let disposed = false;
    let inferenceInFlight = false;
    let intervalId: number | undefined;
    let inferenceTimeoutId: number | undefined;
    let worker: Worker | null = null;
    let stageCandidate: FishStage | null = null;
    let stageCandidateCount = 0;
    let stableStage: FishStage | null = null;
    let lastStagePredictionAtMs: number | null = null;
    let lastStageTransition: FishStageTransition | null = null;
    let fishStageStatus: FishStageDetectionStatus = "loading";
    let fishStageMessage = fishId ? "工程判定モデルを確認しています。" : "この魚は工程判定モデルの対象外です。";
    let removeVisibilityListener: (() => void) | undefined;
    const initializationController = new AbortController();

    setDetection({
      status: "loading",
      message: "認識モデルを読み込んでいます。",
      observation: null,
      fishStage: { ...STAGE_IDLE, status: "loading", message: fishStageMessage },
    });

    const stopInference = () => {
      if (intervalId !== undefined) window.clearInterval(intervalId);
      if (inferenceTimeoutId !== undefined) window.clearTimeout(inferenceTimeoutId);
      intervalId = undefined;
      inferenceTimeoutId = undefined;
      inferenceInFlight = false;
      worker?.terminate();
      worker = null;
    };

    const fail = (error: unknown = ERROR_MESSAGE) => {
      if (disposed) return;
      stopInference();
      fishStageStatus = "error";
      fishStageMessage = "工程判定Workerでエラーが発生しました。";
      setDetection({
        status: "error",
        message: `MediaPipe: ${errorMessage(error)}`,
        observation: null,
        fishStage: { status: "error", message: fishStageMessage, stage: null, score: null, transition: lastStageTransition },
      });
    };

    const handleInferenceWorkerError = (event: ErrorEvent) => {
      fail(event.message || "認識Workerが停止しました。");
    };

    const handleFishStagePrediction = (prediction: { label: string; score: number; capturedAt: string } | null | undefined) => {
      if (fishStageStatus === "unavailable" || fishStageStatus === "error") return;
      const stage = prediction ? parseFishStage(prediction.label) : null;
      const capturedAtMs = prediction ? Date.parse(prediction.capturedAt) : Number.NaN;
      if (!prediction || !stage || !Number.isFinite(prediction.score) || prediction.score < FISH_STAGE_MIN_SCORE || !Number.isFinite(capturedAtMs)) {
        stageCandidate = null;
        stageCandidateCount = 0;
        lastStagePredictionAtMs = null;
        stableStage = null;
        lastStageTransition = null;
        fishStageStatus = "uncertain";
        fishStageMessage = "工程をはっきり判定できません。映像を確認してください。";
        setDetection((current) => ({
          ...current,
          fishStage: { status: fishStageStatus, message: fishStageMessage, stage: null, score: null, transition: lastStageTransition },
        }));
        return;
      }

      if (lastStageTransition && capturedAtMs - Date.parse(lastStageTransition.capturedAt) > FISH_STAGE_TRANSITION_NOTICE_MS) {
        lastStageTransition = null;
      }
      if (lastStagePredictionAtMs !== null
        && (capturedAtMs <= lastStagePredictionAtMs || capturedAtMs - lastStagePredictionAtMs > FISH_STAGE_MAX_FRAME_GAP_MS)) {
        // A long pause or a wall-clock jump breaks continuity. Re-establish a baseline
        // before reporting another transition so three unrelated frames cannot confirm it.
        stageCandidate = null;
        stageCandidateCount = 0;
        stableStage = null;
        lastStageTransition = null;
      }
      lastStagePredictionAtMs = capturedAtMs;

      if (stageCandidate === stage) stageCandidateCount += 1;
      else {
        stageCandidate = stage;
        stageCandidateCount = 1;
      }

      if (stageCandidateCount < FISH_STAGE_STABLE_FRAMES) {
        fishStageStatus = "active";
        fishStageMessage = `工程候補「${fishStageLabel(stage)}」を確認中（${stageCandidateCount}/${FISH_STAGE_STABLE_FRAMES}回一致）。`;
        setDetection((current) => ({
          ...current,
          fishStage: { status: fishStageStatus, message: fishStageMessage, stage: stableStage, score: null, transition: lastStageTransition },
        }));
        return;
      }

      if (stableStage && stableStage !== stage) {
        lastStageTransition = { from: stableStage, to: stage, capturedAt: prediction.capturedAt };
      }
      stableStage = stage;
      fishStageStatus = "active";
      fishStageMessage = `現在の工程候補：${fishStageLabel(stage)}（${Math.round(prediction.score * 100)}%）。`;
      setDetection((current) => ({
        ...current,
        fishStage: { status: fishStageStatus, message: fishStageMessage, stage, score: prediction.score, transition: lastStageTransition },
      }));
    };

    const handleWorkerMessage = (event: MessageEvent<unknown>) => {
      if (!isWorkerResponse(event.data) || event.data.type === "ready") {
        fail("認識Workerから予期しない応答が返りました。");
        return;
      }

      if (inferenceTimeoutId !== undefined) window.clearTimeout(inferenceTimeoutId);
      inferenceTimeoutId = undefined;
      inferenceInFlight = false;

      if (event.data.type === "error") {
        fail(`MediaPipe推論Workerでエラー: ${event.data.message}`);
        return;
      }

      const parsedObservation = ObservationSchema.safeParse(event.data.observation);
      if (!parsedObservation.success) {
        fail("MediaPipeの検出結果を読み取れません。アプリを再読み込みしてください。");
        return;
      }

      if (document.visibilityState !== "visible") {
        stageCandidate = null;
        stageCandidateCount = 0;
        lastStagePredictionAtMs = null;
        stableStage = null;
        lastStageTransition = null;
        setDetection((current) => ({
          ...current,
          status: "paused",
          message: PAUSED_MESSAGE,
          observation: null,
          fishStage: { status: "paused", message: PAUSED_MESSAGE, stage: null, score: null, transition: lastStageTransition },
        }));
        return;
      }

      const ageMs = Date.now() - Date.parse(parsedObservation.data.capturedAt);
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_OBSERVATION_AGE_MS) {
        stageCandidate = null;
        stageCandidateCount = 0;
        lastStagePredictionAtMs = null;
        stableStage = null;
        lastStageTransition = null;
        fishStageStatus = "uncertain";
        fishStageMessage = "推論が遅れたため、工程判定を保留しています。";
        setDetection({
          status: "active",
          message: "推論に時間がかかったため、古い検出枠を消して最新映像を確認しています。",
          observation: null,
          fishStage: { status: "uncertain", message: fishStageMessage, stage: null, score: null, transition: lastStageTransition },
        });
        return;
      }

      if (event.data.fishStageError) {
        fishStageStatus = "error";
        fishStageMessage = event.data.fishStageError;
        setDetection((current) => ({
          ...current,
          fishStage: { status: "error", message: fishStageMessage, stage: null, score: null, transition: lastStageTransition },
        }));
      } else if (fishStageStatus === "active" || fishStageStatus === "uncertain") {
        handleFishStagePrediction(event.data.fishStagePrediction);
      }

      setDetection((current) => ({ ...current, status: "active", message: ACTIVE_MESSAGE, observation: parsedObservation.data }));
    };

    const startInference = async () => {
      if (disposed || inferenceInFlight || !worker) return;
      if (document.visibilityState !== "visible") {
        stageCandidate = null;
        stageCandidateCount = 0;
        lastStagePredictionAtMs = null;
        stableStage = null;
        lastStageTransition = null;
        setDetection((current) => current.status === "active"
          ? { ...current, status: "paused", message: PAUSED_MESSAGE, observation: null, fishStage: { status: "paused", message: PAUSED_MESSAGE, stage: null, score: null, transition: lastStageTransition } }
          : current);
        return;
      }

      const video = videoRef.current;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

      inferenceInFlight = true;
      let bitmap: ImageBitmap | null = null;
      try {
        const scale = Math.min(1, MAX_FRAME_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
        bitmap = await createImageBitmap(video, {
          resizeWidth: Math.max(1, Math.round(video.videoWidth * scale)),
          resizeHeight: Math.max(1, Math.round(video.videoHeight * scale)),
          resizeQuality: "high",
        });
        if (disposed || !worker) {
          bitmap.close();
          inferenceInFlight = false;
          return;
        }

        worker.postMessage({
          type: "infer",
          bitmap,
          timestampMs: performance.now(),
          capturedAt: new Date().toISOString(),
        } satisfies HeadTailWorkerRequest, [bitmap]);
        bitmap = null;
        inferenceTimeoutId = window.setTimeout(
          () => fail(`MediaPipe推論が${INFERENCE_TIMEOUT_MS / 1_000}秒以内に応答しませんでした。`),
          INFERENCE_TIMEOUT_MS,
        );
      } catch (error) {
        bitmap?.close();
        inferenceInFlight = false;
        fail(`カメラ画像を推論Workerへ渡せませんでした: ${errorMessage(error)}`);
      }
    };

    async function initialize() {
      let modelMissing = false;
      let fishStageModelPath: string | undefined;

      try {
        const modelResponse = await fetch(MODEL_PATH, { method: "HEAD", cache: "no-store" });
        const contentType = modelResponse.headers.get("content-type")?.toLowerCase() ?? "";
        if (!modelResponse.ok || contentType.includes("text/html")) {
          modelMissing = true;
          throw new Error(`認識モデルを読み込めません (HTTP ${modelResponse.status})。`);
        }

        for (const assetPath of MEDIAPIPE_RUNTIME_ASSETS) {
          const response = await fetch(assetPath, { method: "HEAD", cache: "no-store" });
          const assetContentType = response.headers.get("content-type")?.toLowerCase() ?? "";
          if (!response.ok || assetContentType.includes("text/html")) {
            throw new Error(`MediaPipeファイル ${assetPath} を読み込めません (HTTP ${response.status})。`);
          }
        }

        if (fishId) {
          const candidatePath = `/models/fish-stage/${fishId}.tflite`;
          try {
            const response = await fetch(candidatePath, { method: "HEAD", cache: "no-store" });
            const candidateType = response.headers.get("content-type")?.toLowerCase() ?? "";
            if (response.ok && !candidateType.includes("text/html")) fishStageModelPath = candidatePath;
          } catch {
            fishStageModelPath = undefined;
          }
          if (!fishStageModelPath) fishStageMessage = "この魚の工程判定モデルは未配置です。確認済みの撮影データで学習すると有効になります。";
        }

        const inferenceWorker = new Worker(
          new URL("../workers/headTailInference.worker.ts", import.meta.url),
          { type: "module", name: "orewosabake-head-tail-inference" },
        );
        worker = inferenceWorker;
        const ready = await waitForWorkerReady(inferenceWorker, initializationController.signal, {
          type: "initialize",
          modelPath: MODEL_PATH,
          wasmPath: WASM_PATH,
          ...(fishStageModelPath ? { fishStageModelPath } : {}),
        });

        fishStageStatus = ready.fishStageStatus === "ready" ? "active" : ready.fishStageStatus;
        if (fishStageModelPath || !fishId) fishStageMessage = ready.fishStageMessage;

        if (disposed) {
          inferenceWorker.terminate();
          worker = null;
          return;
        }

        inferenceWorker.addEventListener("message", handleWorkerMessage);
        inferenceWorker.addEventListener("error", handleInferenceWorkerError);
        const hidden = document.visibilityState !== "visible";
        setDetection({
          status: hidden ? "paused" : "active",
          message: hidden ? PAUSED_MESSAGE : ACTIVE_MESSAGE,
          observation: null,
          fishStage: {
            status: hidden ? "paused" : fishStageStatus,
            message: hidden ? PAUSED_MESSAGE : fishStageMessage,
            stage: null,
            score: null,
            transition: null,
          },
        });

        document.addEventListener("visibilitychange", handleVisibilityChange);
        removeVisibilityListener = () => document.removeEventListener("visibilitychange", handleVisibilityChange);
        intervalId = window.setInterval(() => void startInference(), INFERENCE_INTERVAL_MS);
        void startInference();
      } catch (error) {
        stopInference();
        if (!disposed) {
          setDetection({
            status: modelMissing ? "unavailable" : "error",
            message: modelMissing
              ? `認識モデルの読み込みに失敗しました。${errorMessage(error)}`
              : `MediaPipeを初期化できませんでした。${errorMessage(error)}`,
            observation: null,
            fishStage: {
              status: modelMissing ? "unavailable" : "error",
              message: modelMissing ? "工程判定は頭・尾検出とは別のモデルが必要です。" : "工程判定を開始できませんでした。",
              stage: null,
              score: null,
              transition: null,
            },
          });
        }
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") {
        stageCandidate = null;
        stageCandidateCount = 0;
        lastStagePredictionAtMs = null;
        stableStage = null;
        lastStageTransition = null;
        setDetection((current) => current.status === "active"
          ? { ...current, status: "paused", message: PAUSED_MESSAGE, observation: null, fishStage: { status: "paused", message: PAUSED_MESSAGE, stage: null, score: null, transition: lastStageTransition } }
          : current);
        return;
      }

      setDetection((current) => current.status === "paused"
        ? { ...current, status: "active", message: ACTIVE_MESSAGE, observation: null, fishStage: { status: fishStageStatus, message: fishStageMessage, stage: null, score: null, transition: lastStageTransition } }
        : current);
      void startInference();
    }

    void initialize();

    return () => {
      disposed = true;
      initializationController.abort();
      removeVisibilityListener?.();
      stopInference();
    };
  }, [enabled, fishId, videoRef]);

  return detection;
}
