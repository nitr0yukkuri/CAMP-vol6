import {
  FilesetResolver,
  ImageClassifier,
  ObjectDetector,
  type ObjectDetectorResult,
} from "@mediapipe/tasks-vision";
import { ObservationSchema, type Observation } from "@orewosabake/contracts";
import { parseFishStage } from "./fishStage";

const DEFAULT_MEDIAPIPE_WASM_PATH = "/mediapipe/wasm";
const DETECTION_SCORE_THRESHOLD = 0.35;
const DETECTION_MAX_RESULTS = 12;

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function toObservation(
  result: ObjectDetectorResult,
  width: number,
  height: number,
  capturedAt: string,
): Observation {
  const detections = result.detections.flatMap((detection) => {
    const category = detection.categories[0];
    const label = category?.categoryName?.toLowerCase();
    const box = detection.boundingBox;

    if ((label !== "head" && label !== "tail") || !category || !box || width <= 0 || height <= 0) {
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

  private constructor(
    private readonly detector: ObjectDetector,
    private fishStageClassifier: ImageClassifier | null,
    fishStageStatus: "ready" | "unavailable" | "error",
    fishStageError?: string,
  ) {
    this.fishStageStatus = fishStageStatus;
    this.fishStageError = fishStageError;
  }

  get fishStagePredictionStatus(): "ready" | "unavailable" | "error" {
    return this.fishStageStatus;
  }

  get fishStageStatusMessage(): string {
    return this.fishStageError ?? "工程判定モデルを読み込みました。";
  }

  static async create(
    modelPath = "/models/head-tail.tflite",
    wasmPath = DEFAULT_MEDIAPIPE_WASM_PATH,
    fishStageModelPath?: string,
  ): Promise<MediaPipeFishInference> {
    // Module workers need MediaPipe's ES module WASM loader.
    const wasmFiles = await FilesetResolver.forVisionTasks(wasmPath, true);
    const detector = await ObjectDetector.createFromOptions(wasmFiles, {
      baseOptions: { modelAssetPath: modelPath },
      runningMode: "VIDEO",
      maxResults: DETECTION_MAX_RESULTS,
      scoreThreshold: DETECTION_SCORE_THRESHOLD,
      categoryAllowlist: ["head", "tail"],
    });

    if (!fishStageModelPath) {
      return new MediaPipeFishInference(
        detector,
        null,
        "unavailable",
        "工程判定モデルが未配置です。この魚の確認済み映像で学習するまで、工程の変化は検知しません。",
      );
    }

    try {
      const fishStageClassifier = await ImageClassifier.createFromOptions(wasmFiles, {
        baseOptions: { modelAssetPath: fishStageModelPath },
        runningMode: "VIDEO",
        maxResults: 5,
      });
      return new MediaPipeFishInference(detector, fishStageClassifier, "ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new MediaPipeFishInference(
        detector,
        null,
        "error",
        `工程判定モデルを読み込めませんでした: ${message.replace(/\s+/g, " ").slice(0, 180)}`,
      );
    }
  }

  detectBitmapFrame(bitmap: ImageBitmap, timestampMs: number, capturedAt: string): {
    observation: Observation;
    fishStagePrediction: { label: string; score: number; capturedAt: string } | null;
    fishStageError?: string;
  } {
    const monotonicTimestamp = Math.max(timestampMs, this.lastTimestampMs + 1);
    const result = this.detector.detectForVideo(bitmap, monotonicTimestamp);
    this.lastTimestampMs = monotonicTimestamp;
    const observation = toObservation(result, bitmap.width, bitmap.height, capturedAt);

    if (!this.fishStageClassifier) return { observation, fishStagePrediction: null };
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
        fishStagePrediction: stage && score !== undefined && Number.isFinite(score)
          ? { label: stage, score: clampRatio(score), capturedAt }
          : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fishStageError = `工程判定に失敗しました: ${message.replace(/\s+/g, " ").slice(0, 180)}`;
      this.fishStageStatus = "error";
      this.fishStageClassifier.close();
      this.fishStageClassifier = null;
      return { observation, fishStagePrediction: null, fishStageError: this.fishStageError };
    }
  }

  close(): void {
    this.fishStageClassifier?.close();
    this.detector.close();
  }
}
