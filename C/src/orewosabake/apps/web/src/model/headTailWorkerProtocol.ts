export type HeadTailWorkerRequest =
  | { type: "initialize"; modelPath: string; wasmPath: string; fishStageModelPath?: string }
  | { type: "infer"; bitmap: ImageBitmap; timestampMs: number; capturedAt: string };

export type HeadTailWorkerResponse =
  | {
      type: "ready";
      fishStageStatus: "ready" | "unavailable" | "error";
      fishStageMessage: string;
    }
  | {
      type: "result";
      observation: unknown;
      fishStagePrediction?: { label: string; score: number; capturedAt: string } | null;
      fishStageError?: string;
    }
  | { type: "error"; message: string };
