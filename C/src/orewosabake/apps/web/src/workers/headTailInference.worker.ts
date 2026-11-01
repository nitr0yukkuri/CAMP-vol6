import { MediaPipeFishInference } from "../model/mediapipeHeadTailDetector";
import type { HeadTailWorkerRequest, HeadTailWorkerResponse } from "../model/headTailWorkerProtocol";

type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<HeadTailWorkerRequest>) => void): void;
  postMessage(message: HeadTailWorkerResponse): void;
};

const workerScope = self as unknown as WorkerScope;
let detector: MediaPipeFishInference | null = null;
let initialization: Promise<void> | null = null;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240) || "原因を特定できませんでした。";
}

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  if (request.type === "initialize") {
    initialization ??= MediaPipeFishInference.create(request.modelPath, request.wasmPath, request.fishStageModelPath)
      .then((readyDetector) => {
        detector = readyDetector;
      });

    void initialization.then(
      () => workerScope.postMessage({
        type: "ready",
        fishStageStatus: detector?.fishStagePredictionStatus ?? "unavailable",
        fishStageMessage: detector?.fishStageStatusMessage ?? "工程判定モデルが利用できません。",
      }),
      (error: unknown) => workerScope.postMessage({ type: "error", message: errorMessage(error) }),
    );
    return;
  }

  if (!detector) {
    request.bitmap.close();
    workerScope.postMessage({ type: "error", message: "MediaPipe is not initialized" });
    return;
  }

  try {
    const result = detector.detectBitmapFrame(request.bitmap, request.timestampMs, request.capturedAt);
    workerScope.postMessage({
      type: "result",
      observation: result.observation,
      fishStagePrediction: result.fishStagePrediction,
      ...(result.fishStageError ? { fishStageError: result.fishStageError } : {}),
    });
  } catch (error) {
    workerScope.postMessage({ type: "error", message: errorMessage(error) });
  } finally {
    request.bitmap.close();
  }
});
