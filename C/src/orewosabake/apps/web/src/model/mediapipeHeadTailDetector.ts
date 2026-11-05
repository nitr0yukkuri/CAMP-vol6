import {
  FaceDetector,
  FilesetResolver,
  ImageClassifier,
  ObjectDetector,
  type Detection,
  type ObjectDetectorResult,
} from "@mediapipe/tasks-vision";
import { ObservationSchema, type Observation } from "@orewosabake/contracts";
import { FISH_STAGE_MODEL_LABELS, parseFishStage } from "./fishStage";

const DEFAULT_MEDIAPIPE_WASM_PATH = "/mediapipe/wasm";
const DEFAULT_FACE_MODEL_PATH = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const DETECTION_SCORE_THRESHOLD = 0.35;
const DETECTION_MAX_RESULTS = 12;
const NON_FISH_GATE_SCORE_THRESHOLD = 0.5;
const FACE_DETECTION_MIN_CONFIDENCE = 0.5;
const FACE_MODEL_DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_FACE_MODEL_BYTES = 10 * 1024 * 1024;

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

type PixelBox = { x: number; y: number; width: number; height: number };

type FaceCandidate = { score: number; box: PixelBox };

function faceCandidates(detections: Detection[]): FaceCandidate[] {
  return detections.flatMap((detection) => {
    const box = detection.boundingBox;
    const score = detection.categories[0]?.score ?? 0;
    return box && score >= FACE_DETECTION_MIN_CONFIDENCE
      ? [{
        score,
        box: { x: box.originX, y: box.originY, width: box.width, height: box.height },
      }]
      : [];
  });
}

function toObservation(
  result: ObjectDetectorResult,
  width: number,
  height: number,
  capturedAt: string,
): Observation {
  const nonFishSceneDetected = result.detections.some((detection) => {
    const category = detection.categories[0];
    return category?.categoryName?.toLowerCase() === "non_fish" && category.score >= NON_FISH_GATE_SCORE_THRESHOLD;
  });
  if (nonFishSceneDetected) {
    return ObservationSchema.parse({ source: "mediapipe", capturedAt, detections: [] });
  }
  const detections = result.detections.flatMap((detection) => {
    const category = detection.categories[0];
    const label = category?.categoryName?.toLowerCase();
    const box = detection.boundingBox;

    if ((label !== "head" && label !== "tail") || !category || !box || width <= 0 || height <= 0
) {
      return [];
    }

    const x = clampRatio(box.originX / width);
    const y = clampRatio(box.originY / height);
    const right = clampRatio((box.originX + box.width) / width);
    const bottom = clampRatio((box.originY + box.height) / height);

    return [{
      label,
      score: clampRatio(category.score),
      box: {
        x,
        y,
        width: Math.max(0, right - x),
        height: Math.max(0, bottom - y),
      },
    }];
  });

  return ObservationSchema.parse({
    source: "mediapipe",
    capturedAt,
    detections,
  });
}

export class MediaPipeFishInference {
  private lastTimestampMs = -1;
  private fishStageError: string | undefined;
  private fishStageStatus: "ready" | "unavailable" | "error";
  private faceDetectionError: string | null;

  private constructor(
    private readonly detector: ObjectDetector,
    private faceDetector: FaceDetector | null,
    private fishStageClassifier: ImageClassifier | null,
    fishStageStatus: "ready" | "unavailable" | "error",
    fishStageError?: string,
    faceDetectionError: string | null = null,
  ) {
    this.fishStageStatus = fishStageStatus;
    this.fishStageError = fishStageError;
    this.faceDetectionError = faceDetectionError;
  }

  get fishStagePredictionStatus(): "ready" | "unavailable" | "error" {
    return this.fishStageStatus;
  }

  get fishStageStatusMessage(): string {
    return this.fishStageError ?? "魚の状態判定モデルを読み込みました。";
  }

  get faceDetectionReady(): boolean {
    return this.faceDetector !== null;
  }

  get faceDetectionStatusMessage(): string {
    return this.faceDetectionError ?? "人物チェックモデルを読み込みました。";
  }

  static async create(
    modelPath = "/models/head-tail.tflite",
    wasmPath = DEFAULT_MEDIAPIPE_WASM_PATH,
    fishStageModelPath?: string,
    faceModelPath = DEFAULT_FACE_MODEL_PATH,
    useModule = true,
  ): Promise<MediaPipeFishInference> {
    // Workers use module glue; the page-thread compatibility path can use classic WASM glue.
    const wasmFiles = await FilesetResolver.forVisionTasks(wasmPath, useModule);
    const faceDetectorTask = (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FACE_MODEL_DOWNLOAD_TIMEOUT_MS);
      let modelBuffer: Uint8Array;
      try {
        const response = await fetch(faceModelPath, { cache: "force-cache", signal: controller.signal });
        if (!response.ok || response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
          throw new Error(`HTTP ${response.status}`);
        }
        modelBuffer = new Uint8Array(await response.arrayBuffer());
      } finally {
        clearTimeout(timeoutId);
      }
      const signature = new TextDecoder().decode(modelBuffer.subarray(4, 8));
      if (modelBuffer.length < 8 || modelBuffer.length >= MAX_FACE_MODEL_BYTES || signature !== "TFL3") {
        throw new Error("The downloaded face-check model is not a valid TFLite file.");
      }
      return FaceDetector.createFromOptions(wasmFiles, {
        baseOptions: { modelAssetBuffer: modelBuffer },
        runningMode: "VIDEO",
        minDetectionConfidence: FACE_DETECTION_MIN_CONFIDENCE,
      });
    })();
    const [detectorResult, faceDetectorResult] = await Promise.allSettled([
      ObjectDetector.createFromOptions(wasmFiles, {
        baseOptions: { modelAssetPath: modelPath },
        runningMode: "VIDEO",
        maxResults: DETECTION_MAX_RESULTS,
        scoreThreshold: DETECTION_SCORE_THRESHOLD,
        categoryAllowlist: ["head", "tail", "non_fish"],
      }),
      faceDetectorTask,
    ]);
    if (detectorResult.status === "rejected") {
      if (faceDetectorResult.status === "fulfilled") faceDetectorResult.value.close();
      throw detectorResult.reason;
    }
    const detector = detectorResult.value;
    let faceDetector: FaceDetector | null = null;
    let faceDetectionError: string | null = null;
    if (faceDetectorResult.status === "fulfilled") {
      faceDetector = faceDetectorResult.value;
    } else {
      const message = faceDetectorResult.reason instanceof Error
        ? faceDetectorResult.reason.message
        : String(faceDetectorResult.reason);
      faceDetectionError = `人物チェックモデルを読み込めませんでした: ${message.replace(/\s+/g, " ").slice(0, 180)}`;
    }

    if (!fishStageModelPath) {
      return new MediaPipeFishInference(
        detector,
        faceDetector,
        null,
        "unavailable",
        "魚の状態判定モデルが未配置です。この魚の確認済み映像で学習するまで、状態の変化は検知しません。",
        faceDetectionError,
      );
    }

    try {
      const fishStageClassifier = await ImageClassifier.createFromOptions(wasmFiles, {
        baseOptions: { modelAssetPath: fishStageModelPath },
        runningMode: "VIDEO",
        // Keep the optional `unknown` reject category visible to runtime scoring.
        maxResults: FISH_STAGE_MODEL_LABELS.length,
      });
      return new MediaPipeFishInference(detector, faceDetector, fishStageClassifier, "ready", undefined, faceDetectionError);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new MediaPipeFishInference(
        detector,
        faceDetector,
        null,
        "error",
        `魚の状態判定モデルを読み込めませんでした: ${message.replace(/\s+/g, " ").slice(0, 180)}`,
        faceDetectionError,
      );
    }
  }

  detectFacesInBitmap(bitmap: ImageBitmap, timestampMs: number): boolean {
    if (!this.faceDetector) throw new Error(this.faceDetectionError ?? "人物チェックモデルを利用できません。");
    const monotonicTimestamp = Math.max(timestampMs, this.lastTimestampMs + 1);
    this.lastTimestampMs = monotonicTimestamp;
    try {
      const candidates = faceCandidates(this.faceDetector.detectForVideo(bitmap, monotonicTimestamp).detections);
      const detected = candidates.length > 0;
      console.debug("[MediaPipe] face-check", {
        threshold: FACE_DETECTION_MIN_CONFIDENCE,
        frame: { width: bitmap.width, height: bitmap.height },
        detected,
        candidates: candidates.map(({ score, box }) => ({
          score: Number(score.toFixed(3)),
          box,
        })),
      });
      return detected;
    } catch (error) {
      this.faceDetector.close();
      this.faceDetector = null;
      const message = error instanceof Error ? error.message : String(error);
      this.faceDetectionError = `人物チェックに失敗しました: ${message.replace(/\s+/g, " ").slice(0, 180)}`;
      throw new Error(this.faceDetectionError);
    }
  }

  detectBitmapFrame(bitmap: ImageBitmap, timestampMs: number, capturedAt: string): {
    observation: Observation;
    faceDetectionReady: boolean;
    faceDetectionMessage: string;
    fishStagePrediction: { label: string; score: number; capturedAt: string } | null;
    fishStageError?: string;
  } {
    const monotonicTimestamp = Math.max(timestampMs, this.lastTimestampMs + 1);
    const result = this.detector.detectForVideo(bitmap, monotonicTimestamp);
    this.lastTimestampMs = monotonicTimestamp;
    const observation = toObservation(result, bitmap.width, bitmap.height, capturedAt);

    if (!this.fishStageClassifier || !faces || faces.length > 0) {
      return {
        observation,
        faceDetectionReady: this.faceDetector !== null,
        faceDetectionMessage: this.faceDetectionStatusMessage,
        fishStagePrediction: null,
      };
    }
    try {
      const classification = this.fishStageClassifier.classifyForVideo(bitmap, monotonicTimestamp);
      const categories = classification.classifications.flatMap((group) => group.categories);
      const best = categories.reduce<(typeof categories)[number] | null>(
        (current, category) => !current || category.score > current.score ? category : current,
        null,
      );
      const stage = best ? parseFishStage(best.categoryName) ?? parseFishStage(best.displayName) : null;
      const score = best?.score;
      return {
        observation,
        faceDetectionReady: this.faceDetector !== null,
        faceDetectionMessage: this.faceDetectionStatusMessage,
        fishStagePrediction: stage && score !== undefined && Number.isFinite(score)
          ? { label: stage, score: clampRatio(score), capturedAt }
          : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fishStageError = `魚の状態判定に失敗しました: ${message.replace(/\s+/g, " ").slice(0, 180)}`;
      this.fishStageStatus = "error";
      this.fishStageClassifier.close();
      this.fishStageClassifier = null;
      return {
        observation,
        faceDetectionReady: this.faceDetector !== null,
        faceDetectionMessage: this.faceDetectionStatusMessage,
        fishStagePrediction: null,
        fishStageError: this.fishStageError,
      };
    }
  }

  close(): void {
    this.fishStageClassifier?.close();
    this.faceDetector?.close();
    this.detector.close();
  }
}
