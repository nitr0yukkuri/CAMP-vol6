export type HeadTailWorkerRequest =
  | { type: "initialize"; modelPath: string; wasmPath: string; fishStageModelPath?: string; faceModelPath: string }
  | { type: "infer"; bitmap: ImageBitmap; timestampMs: number; capturedAt: string }
  | { type: "check-face"; bitmap: ImageBitmap; timestampMs: number; requestId: number };

export type HeadTailWorkerResponse =
  | {
      type: "ready";
      fishStageStatus: "ready" | "unavailable" | "error";
      fishStageMessage: string;
      faceDetectionReady: boolean;
      faceDetectionMessage: string;
    }
  | {
      type: "result";
      observation: unknown;
      faceDetectionReady: boolean;
      faceDetectionMessage: string;
      fishStagePrediction?: { label: string; score: number; capturedAt: string } | null;
      fishStageError?: string;
    }
  | { type: "face-check-result"; requestId: number; detected: boolean }
  | { type: "face-check-error"; requestId: number; message: string }
  | { type: "error"; message: string };
