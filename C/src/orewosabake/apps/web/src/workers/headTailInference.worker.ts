import { MediaPipeHeadTailDetector } from "../model/mediapipeHeadTailDetector";
import type { HeadTailWorkerRequest, HeadTailWorkerResponse } from "../model/headTailWorkerProtocol";

type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<HeadTailWorkerRequest>) => void): void;
  postMessage(message: HeadTailWorkerResponse): void;
};

const workerScope = self as unknown as WorkerScope;
let detector: MediaPipeHeadTailDetector | null = null;
let initialization: Promise<void> | null = null;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240) || "原因を特定できませんでした。";
}

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  if (request.type === "initialize") {
    initialization ??= MediaPipeHeadTailDetector.create(request.modelPath, request.wasmPath)
      .then((readyDetector) => {
        detector = readyDetector;
      });

    void initialization.then(
      () => workerScope.postMessage({ type: "ready" }),
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
    const observation = detector.detectBitmapFrame(request.bitmap, request.timestampMs, request.capturedAt);
    workerScope.postMessage({ type: "result", observation });
  } catch (error) {
    workerScope.postMessage({ type: "error", message: errorMessage(error) });
  } finally {
    request.bitmap.close();
  }
});
