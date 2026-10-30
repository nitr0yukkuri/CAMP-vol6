import { z } from "zod";

export const FishStateSchema = z.enum([
  "whole_fish",
  "head_removed",
  "opened",
  "filleted",
  "unknown",
]);

export const GuideStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  expectedState: FishStateSchema,
});

export const GuideSchema = z.object({
  title: z.string(),
  steps: z.array(GuideStepSchema).min(1),
});

export const ModelStatusSchema = z.object({
  status: z.enum(["not_trained", "ready"]),
  runtime: z.literal("mediapipe_tasks_vision"),
  task: z.literal("head_tail_object_detection"),
  modelName: z.string().nullable(),
  processStateRecognition: z.literal("not_available"),
});

export const DetectionSchema = z.object({
  label: z.enum(["head", "tail"]),
  score: z.number().min(0).max(1),
  box: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  }),
});

export const ObservationSchema = z.object({
  source: z.enum(["mock", "mediapipe"]),
  capturedAt: z.string().datetime(),
  detections: z.array(DetectionSchema),
});

export type FishState = z.infer<typeof FishStateSchema>;
export type GuideStep = z.infer<typeof GuideStepSchema>;
export type Guide = z.infer<typeof GuideSchema>;
export type ModelStatus = z.infer<typeof ModelStatusSchema>;
export type Detection = z.infer<typeof DetectionSchema>;
export type Observation = z.infer<typeof ObservationSchema>;

export const MOCK_GUIDE: Guide = GuideSchema.parse({
  title: "魚の状態を確認する（表示モック）",
  steps: [
    {
      id: "observe",
      title: "魚全体を映す",
      description: "魚を画面に収め、向きと全体の状態を確認します。",
      expectedState: "whole_fish",
    },
    {
      id: "parts",
      title: "頭と尾を確認する",
      description: "画面外や手・道具による遮蔽を、切除済みと混同しません。",
      expectedState: "unknown",
    },
    {
      id: "review",
      title: "工程を自分で確認する",
      description: "認識結果だけで工程を進めず、利用者が確認して操作します。",
      expectedState: "unknown",
    },
  ],
});

export const MOCK_MODEL_STATUS: ModelStatus = ModelStatusSchema.parse({
  status: "not_trained",
  runtime: "mediapipe_tasks_vision",
  task: "head_tail_object_detection",
  modelName: null,
  processStateRecognition: "not_available",
});

export const MOCK_OBSERVATION: Observation = ObservationSchema.parse({
  source: "mock",
  capturedAt: new Date("2026-10-29T09:00:00.000Z").toISOString(),
  detections: [
    { label: "head", score: 0.82, box: { x: 0.13, y: 0.35, width: 0.19, height: 0.24 } },
    { label: "tail", score: 0.69, box: { x: 0.72, y: 0.37, width: 0.17, height: 0.2 } },
  ],
});
