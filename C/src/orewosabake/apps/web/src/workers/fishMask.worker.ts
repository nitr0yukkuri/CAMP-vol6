import { FilesetResolver, InteractiveSegmenter, type Stroke } from "@mediapipe/tasks-vision";
import type { FishMaskStroke, FishMaskWorkerRequest, FishMaskWorkerResponse } from "../model/fishMaskWorkerProtocol";

type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<FishMaskWorkerRequest>) => void): void;
  postMessage(message: FishMaskWorkerResponse, transfer?: Transferable[]): void;
};

const workerScope = self as unknown as WorkerScope;
let segmenter: InteractiveSegmenter | null = null;
let initialization: Promise<void> | null = null;
let imageIsSet = false;
let operations = Promise.resolve();

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240) || "原因を特定できませんでした。";
}

function toMediaPipeStrokes(strokes: FishMaskStroke[]): Stroke[] {
  // MediaPipe Tasks Vision 1.2.0 declares BrushMode but does not export it at runtime.
  const positiveBrushMode = 1 as Stroke["brushMode"];
  const negativeBrushMode = 2 as Stroke["brushMode"];
  return strokes.map((stroke) => ({
    brushMode: stroke.mode === "include" ? positiveBrushMode : negativeBrushMode,
    point: stroke.points,
    isCompleted: true,
  }));
}

async function initialize(wasmPath: string, modelPath: string): Promise<void> {
  initialization ??= (async () => {
    const vision = await FilesetResolver.forVisionTasks(wasmPath, true);
    segmenter = await InteractiveSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: modelPath },
    });
  })();
  await initialization;
}

function postError(error: unknown, requestId?: number): void {
  const response: FishMaskWorkerResponse = { type: "error", message: errorMessage(error), ...(requestId === undefined ? {} : { requestId }) };
  workerScope.postMessage(response);
}

function runSegmentation(requestId: number, strokes: FishMaskStroke[]): void {
  if (!segmenter || !imageIsSet) throw new Error("画像を選択してから切り抜いてください。");
  if (strokes.length === 0) throw new Error("魚の上をタップして、切り抜き対象を指定してください。");
  const mask = segmenter.segment(toMediaPipeStrokes(strokes));
  try {
    const maskBuffer = new Float32Array(mask.getAsFloat32Array()).buffer;
    workerScope.postMessage({
      type: "result",
      requestId,
      width: mask.width,
      height: mask.height,
      maskBuffer,
    }, [maskBuffer]);
  } finally {
    mask.close();
  }
}

async function handleRequest(request: FishMaskWorkerRequest): Promise<void> {
  if (request.type === "initialize") {
    try {
      await initialize(request.wasmPath, request.modelPath);
      workerScope.postMessage({ type: "ready" });
    } catch (error) {
      postError(error);
    }
    return;
  }

  try {
    if (request.type === "select") {
      try {
        if (!segmenter) throw new Error("切り抜きモデルを読み込んでください。");
        segmenter.setImage(request.bitmap);
        imageIsSet = true;
      } finally {
        request.bitmap.close();
      }
    }
    if (!segmenter) throw new Error("切り抜きモデルを読み込んでください。");
    runSegmentation(request.requestId, request.strokes);
  } catch (error) {
    postError(error, request.requestId);
  }
}

workerScope.addEventListener("message", (event: MessageEvent<FishMaskWorkerRequest>) => {
  operations = operations.then(() => handleRequest(event.data)).catch((error: unknown) => {
    postError(error, "requestId" in event.data ? event.data.requestId : undefined);
  });
});

