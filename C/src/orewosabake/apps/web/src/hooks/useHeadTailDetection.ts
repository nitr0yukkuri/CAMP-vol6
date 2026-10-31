import { useEffect, useState, type RefObject } from "react";
import { ObservationSchema, type Observation } from "@orewosabake/contracts";
import type { HeadTailWorkerRequest, HeadTailWorkerResponse } from "../model/headTailWorkerProtocol";

export type HeadTailDetectionStatus = "idle" | "loading" | "active" | "paused" | "unavailable" | "error";

export type HeadTailDetection = {
  status: HeadTailDetectionStatus;
  message: string;
  observation: Observation | null;
};

const MODEL_PATH = "/models/head-tail.tflite";
const WASM_PATH = "/mediapipe/wasm";
const INFERENCE_INTERVAL_MS = 1_000;
const INFERENCE_TIMEOUT_MS = 15_000;
const INITIALIZATION_TIMEOUT_MS = 90_000;
const MAX_OBSERVATION_AGE_MS = 2_000;
const MAX_FRAME_DIMENSION = 832;
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

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240) || "原因を特定できませんでした。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkerResponse(value: unknown): value is HeadTailWorkerResponse {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "ready") return true;
  if (value.type === "result") return "observation" in value;
  return value.type === "error" && typeof value.message === "string";
}

function waitForWorkerReady(
  worker: Worker,
  signal: AbortSignal,
  request: Extract<HeadTailWorkerRequest, { type: "initialize" }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeoutId: number | undefined;
    let settled = false;

    const cleanup = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      signal.removeEventListener("abort", handleAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (!isWorkerResponse(event.data)) {
        finish(new Error("The inference worker returned an invalid initialization response"));
      } else if (event.data.type === "ready") {
        finish();
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
): HeadTailDetection {
  const [detection, setDetection] = useState<HeadTailDetection>({
    status: "idle",
    message: IDLE_MESSAGE,
    observation: null,
  });

  useEffect(() => {
    if (!enabled) {
      setDetection({ status: "idle", message: IDLE_MESSAGE, observation: null });
      return;
    }

    let disposed = false;
    let inferenceInFlight = false;
    let intervalId: number | undefined;
    let inferenceTimeoutId: number | undefined;
    let worker: Worker | null = null;
    let removeVisibilityListener: (() => void) | undefined;
    const initializationController = new AbortController();

    setDetection({ status: "loading", message: "認識モデルを読み込んでいます。", observation: null });

    const stopInference = () => {
      if (intervalId !== undefined) window.clearInterval(intervalId);
      if (inferenceTimeoutId !== undefined) window.clearTimeout(inferenceTimeoutId);
      intervalId = undefined;
      inferenceTimeoutId = undefined;
      inferenceInFlight = false;
      worker?.terminate();
      worker = null;
    };

    const fail = () => {
      if (disposed) return;
      stopInference();
      setDetection({ status: "error", message: ERROR_MESSAGE, observation: null });
    };

    const handleWorkerMessage = (event: MessageEvent<unknown>) => {
      if (!isWorkerResponse(event.data) || event.data.type === "ready") {
        fail();
        return;
      }

      if (inferenceTimeoutId !== undefined) window.clearTimeout(inferenceTimeoutId);
      inferenceTimeoutId = undefined;
      inferenceInFlight = false;

      if (event.data.type === "error") {
        fail();
        return;
      }

      const parsedObservation = ObservationSchema.safeParse(event.data.observation);
      if (!parsedObservation.success) {
        fail();
        return;
      }

      if (document.visibilityState !== "visible") {
        setDetection({ status: "paused", message: PAUSED_MESSAGE, observation: null });
        return;
      }

      const ageMs = Date.now() - Date.parse(parsedObservation.data.capturedAt);
      if (ageMs > MAX_OBSERVATION_AGE_MS) {
        setDetection({
          status: "active",
          message: "推論に時間がかかったため、古い検出枠を消して最新映像を確認しています。",
          observation: null,
        });
        return;
      }

      setDetection({ status: "active", message: ACTIVE_MESSAGE, observation: parsedObservation.data });
    };

    const startInference = async () => {
      if (disposed || inferenceInFlight || !worker) return;
      if (document.visibilityState !== "visible") {
        setDetection((current) => current.status === "active"
          ? { status: "paused", message: PAUSED_MESSAGE, observation: null }
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
          return;
        }

        worker.postMessage({
          type: "infer",
          bitmap,
          timestampMs: performance.now(),
          capturedAt: new Date().toISOString(),
        } satisfies HeadTailWorkerRequest, [bitmap]);
        bitmap = null;
        inferenceTimeoutId = window.setTimeout(fail, INFERENCE_TIMEOUT_MS);
      } catch {
        bitmap?.close();
        inferenceInFlight = false;
        fail();
      }
    };

    async function initialize() {
      let modelMissing = false;

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

        const inferenceWorker = new Worker(
          new URL("../workers/headTailInference.worker.ts", import.meta.url),
          { type: "module", name: "orewosabake-head-tail-inference" },
        );
        worker = inferenceWorker;
        await waitForWorkerReady(inferenceWorker, initializationController.signal, {
          type: "initialize",
          modelPath: MODEL_PATH,
          wasmPath: WASM_PATH,
        });

        if (disposed) {
          inferenceWorker.terminate();
          worker = null;
          return;
        }

        inferenceWorker.addEventListener("message", handleWorkerMessage);
        inferenceWorker.addEventListener("error", fail);
        const hidden = document.visibilityState !== "visible";
        setDetection({
          status: hidden ? "paused" : "active",
          message: hidden ? PAUSED_MESSAGE : ACTIVE_MESSAGE,
          observation: null,
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
              ? "認識モデルが未配置です。mlの学習手順を実行すると検出が有効になります。"
              : `MediaPipeを初期化できませんでした。${errorMessage(error)}`,
            observation: null,
          });
        }
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") {
        setDetection((current) => current.status === "active"
          ? { status: "paused", message: PAUSED_MESSAGE, observation: null }
          : current);
        return;
      }

      setDetection((current) => current.status === "paused"
        ? { status: "active", message: ACTIVE_MESSAGE, observation: null }
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
  }, [enabled, videoRef]);

  return detection;
}
