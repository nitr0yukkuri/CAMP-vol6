import { z } from "zod";

export const FishStateSchema = z.enum([
  "whole_fish",
  "head_removed",
  "opened",
  "filleted",
  "unknown",
]);

export const FishCategorySchema = z.enum(["saltwater", "freshwater", "crustacean", "unknown"]);

export const GuideContextRequestSchema = z.object({
  fishName: z.string().trim().min(1).max(80),
  fishCategory: FishCategorySchema,
  fishState: FishStateSchema,
}).strict();

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

export const FishIdSchema = z.enum(["aji", "saba", "tai"]);
export const PreparationIdSchema = z.enum(["edible_portion"]);

export const GuideRequestSchema = z.object({
  fishId: FishIdSchema,
  preparationId: PreparationIdSchema,
}).strict();

export const AdvanceGuideStepRequestSchema = z.object({
  stepId: z.string().min(1),
  source: z.enum(["button", "voice"]),
  transcript: z.string().optional(),
}).strict();

export const GuideSessionSchema = z.object({
  sessionId: z.string().uuid(),
  fishId: FishIdSchema,
  preparationId: PreparationIdSchema,
  guide: GuideSchema,
  currentStep: GuideStepSchema.nullable(),
  currentStepIndex: z.number().int().min(0),
  completedStepIds: z.array(z.string()),
  status: z.enum(["active", "completed"]),
  source: z.literal("mock"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CatalogSchema = z.object({
  fish: z.array(z.object({ id: FishIdSchema, name: z.string() })),
  preparations: z.array(z.object({ id: PreparationIdSchema, name: z.string() })),
  guideAvailability: z.enum(["not_configured", "available"]),
});

export const ModelStatusSchema = z.object({
  status: z.enum(["not_trained", "ready"]),
  runtime: z.literal("mediapipe_tasks_vision"),
  task: z.literal("head_tail_object_detection"),
  modelName: z.string().nullable(),
  processStateRecognition: z.literal("not_available"),
});

export const OrientationConfigSchema = z.object({
  cookingGuide: z.object({
    preferredOrientation: z.enum(["portrait", "landscape"]),
    behavior: z.enum(["prompt", "lock_when_supported"]),
  }),
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
export type FishCategory = z.infer<typeof FishCategorySchema>;
export type GuideContextRequest = z.infer<typeof GuideContextRequestSchema>;
export type GuideStep = z.infer<typeof GuideStepSchema>;
export type Guide = z.infer<typeof GuideSchema>;
export type GuideRequest = z.infer<typeof GuideRequestSchema>;
export type AdvanceGuideStepRequest = z.infer<typeof AdvanceGuideStepRequestSchema>;
export type GuideSession = z.infer<typeof GuideSessionSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type ModelStatus = z.infer<typeof ModelStatusSchema>;
export type OrientationConfig = z.infer<typeof OrientationConfigSchema>;
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

export const ORIENTATION_CONFIG: OrientationConfig = OrientationConfigSchema.parse({
  cookingGuide: {
    preferredOrientation: "landscape",
    behavior: "prompt",
  },
});

export const CATALOG: Catalog = CatalogSchema.parse({
  fish: [
    { id: "aji", name: "あじ" },
    { id: "saba", name: "さば" },
    { id: "tai", name: "鯛" },
  ],
  preparations: [
    { id: "edible_portion", name: "可食部を取り出す" },
  ],
  guideAvailability: "not_configured",
});

export const MOCK_OBSERVATION: Observation = ObservationSchema.parse({
  source: "mock",
  capturedAt: new Date("2026-10-29T09:00:00.000Z").toISOString(),
  detections: [
    { label: "head", score: 0.82, box: { x: 0.13, y: 0.35, width: 0.19, height: 0.24 } },
    { label: "tail", score: 0.69, box: { x: 0.72, y: 0.37, width: 0.17, height: 0.2 } },
  ],
});
