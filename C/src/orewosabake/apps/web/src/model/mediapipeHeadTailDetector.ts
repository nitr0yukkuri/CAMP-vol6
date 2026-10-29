import {
  FilesetResolver,
  ObjectDetector,
  type ObjectDetectorResult,
} from "@mediapipe/tasks-vision";
import { ObservationSchema, type Observation } from "@orewosabake/contracts";

const MEDIAPIPE_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm";

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function toObservation(result: ObjectDetectorResult, width: number, height: number): Observation {
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
    capturedAt: new Date().toISOString(),
    detections,
  });
}

export class MediaPipeHeadTailDetector {
  private lastTimestampMs = -1;

  private constructor(private readonly detector: ObjectDetector) {}

  static async create(modelPath = "/models/head-tail.tflite"): Promise<MediaPipeHeadTailDetector> {
    const wasmFiles = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
    const detector = await ObjectDetector.createFromOptions(wasmFiles, {
      baseOptions: { modelAssetPath: modelPath },
      runningMode: "VIDEO",
      maxResults: 12,
      categoryAllowlist: ["head", "tail"],
    });

    return new MediaPipeHeadTailDetector(detector);
  }

  detectVideoFrame(video: HTMLVideoElement, timestampMs: number): Observation {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      throw new Error("Video frame is not ready");
    }

    const monotonicTimestamp = Math.max(timestampMs, this.lastTimestampMs + 1);
    const result = this.detector.detectForVideo(video, monotonicTimestamp);
    this.lastTimestampMs = monotonicTimestamp;
    return toObservation(result, video.videoWidth, video.videoHeight);
  }

  close(): void {
    this.detector.close();
  }
}
