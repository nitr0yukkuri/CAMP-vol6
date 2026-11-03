export type FishMaskStroke = {
  mode: "include" | "exclude";
  points: Array<{ x: number; y: number }>;
};

export type FishMaskWorkerRequest =
  | { type: "initialize"; wasmPath: string; modelPath: string }
  | { type: "select"; requestId: number; bitmap: ImageBitmap; strokes: FishMaskStroke[] }
  | { type: "refine"; requestId: number; strokes: FishMaskStroke[] };

export type FishMaskWorkerResponse =
  | { type: "ready" }
  | { type: "result"; requestId: number; width: number; height: number; maskBuffer: ArrayBuffer }
  | { type: "error"; requestId?: number; message: string };

