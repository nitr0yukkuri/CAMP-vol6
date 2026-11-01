export type HeadTailWorkerRequest =
  | { type: "initialize"; modelPath: string; wasmPath: string }
  | { type: "infer"; bitmap: ImageBitmap; timestampMs: number; capturedAt: string };

export type HeadTailWorkerResponse =
  | { type: "ready" }
  | { type: "result"; observation: unknown }
  | { type: "error"; message: string };
