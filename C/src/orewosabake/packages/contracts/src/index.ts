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
  // Keep the legacy default so sessions created before source metadata was added still parse.
  source: z.enum(["mock", "public_reference"]).default("mock"),
  sourceLabel: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  expertReviewed: z.boolean().default(false),
});

export const FishIdSchema = z.enum(["aji", "saba", "tai", "hamachi"]);
export const PreparationIdSchema = z.enum(["three_piece_fillet", "edible_portion"]);

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
  source: z.enum(["mock", "public_reference"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CatalogSchema = z.object({
  fish: z.array(z.object({ id: FishIdSchema, name: z.string() })),
  preparations: z.array(z.object({ id: PreparationIdSchema, name: z.string() })),
  guideAvailability: z.enum(["not_configured", "partial", "available"]),
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

export const REFERENCE_GUIDES: Partial<Record<GuideRequest["fishId"], Guide>> = {
  hamachi: GuideSchema.parse({
    title: "ハマチの三枚おろし",
    source: "public_reference",
    sourceLabel: "全国海水養魚協会「魚のおろし方」",
    sourceUrl: "https://www.yoshoku.or.jp/filet/",
    expertReviewed: false,
    steps: [
      { id: "hamachi_scales", title: "うろこを取る", description: "魚の表面を湿らせてから、うろこを取ります。取り残しやすいヒレの近くも目で確認します。", expectedState: "whole_fish" },
      { id: "hamachi_gills", title: "えらを外す", description: "えらの付け根とかまの下側を切り、反対側も同じように外します。", expectedState: "whole_fish" },
      { id: "hamachi_guts", title: "腹を開いて洗う", description: "腹側を尾の近くまで開き、えらと内臓を取り出します。流水で血や汚れを洗い、水気をふき取ります。", expectedState: "opened" },
      { id: "hamachi_head", title: "頭を外す", description: "胸びれの下から頭の付け根へ切り進め、頭を外します。硬くて進まない場合は力をかけ続けず、作業を止めてください。", expectedState: "head_removed" },
      { id: "hamachi_belly_cut", title: "腹側に切り込みを入れる", description: "腹側を手前に置き、尻びれから尾まで切り込みを入れます。魚が安定し、手元が見える状態で進めます。", expectedState: "head_removed" },
      { id: "hamachi_first_side", title: "片側の身を外す", description: "背側にも中骨に沿って切り込みを入れ、尾の付け根から肩口へ身を外します。", expectedState: "unknown" },
      { id: "hamachi_second_side", title: "裏返して反対側を外す", description: "魚を裏返し、同じ要領で反対側の身を外します。", expectedState: "filleted" },
      { id: "hamachi_check", title: "三枚になったか確認する", description: "左右の身2枚と中骨1枚に分かれたことを目で確認します。骨や身の状態はAIが判定しません。", expectedState: "filleted" },
    ],
  }),
  aji: GuideSchema.parse({
    title: "アジの三枚おろし",
    source: "public_reference",
    sourceLabel: "千葉県「アジのおろし方」",
    sourceUrl: "https://www.pref.chiba.lg.jp/suisan/sakana/oroshikata/aji.html",
    expertReviewed: false,
    steps: [
      { id: "aji_zeigo", title: "ぜいごを取る", description: "腹を手前にして置き、包丁を寝かせて尾側からぜいごを取ります。皮をむく場合は、出典資料では省略できるとされています。", expectedState: "whole_fish" },
      { id: "aji_head", title: "頭を外す", description: "胸びれの付け根に沿って頭を外します。刃先が見えない、魚が滑る場合は作業を止めます。", expectedState: "head_removed" },
      { id: "aji_guts", title: "腹を開いて洗う", description: "腹を開いて内臓を取り出し、流水で洗ってから水気をふき取ります。", expectedState: "opened" },
      { id: "aji_first_side", title: "片側の身を外す", description: "腹を手前にし、頭側から中骨に沿って尾まで切り進めます。", expectedState: "unknown" },
      { id: "aji_second_side", title: "裏返して反対側を外す", description: "中骨を下にして置き直し、反対側も同じように身を外します。", expectedState: "filleted" },
      { id: "aji_trim", title: "腹骨を確認する", description: "包丁を寝かせて腹骨をすき取ります。小骨が残っていないかは目と手で確認してください。", expectedState: "filleted" },
    ],
  }),
  saba: GuideSchema.parse({
    title: "サバの三枚おろし",
    source: "public_reference",
    sourceLabel: "千葉県「千葉のさかな料理に挑戦！」",
    sourceUrl: "https://www.pref.chiba.lg.jp/suisan/documents/sabakihonresipi.pdf",
    expertReviewed: false,
    steps: [
      { id: "saba_prepare", title: "表面を洗って頭を外す", description: "表面のぬめりを洗い、胸びれの付け根から頭を外します。", expectedState: "head_removed" },
      { id: "saba_guts", title: "腹を開いて洗う", description: "腹を開いて内臓を取り出し、洗ってから水気をふき取ります。", expectedState: "opened" },
      { id: "saba_belly_cut", title: "腹側から身を外す", description: "腹側から中骨の上を尾まで切り開きます。", expectedState: "unknown" },
      { id: "saba_back_cut", title: "背側に切り込みを入れる", description: "背びれの上に沿って尾側から頭側へ切り込みを入れます。", expectedState: "unknown" },
      { id: "saba_first_side", title: "片側の身を外して腹骨を取る", description: "尾の付け根に切り目を入れ、中骨の上で片側の身を切り離します。腹骨をすき取ります。", expectedState: "unknown" },
      { id: "saba_second_side", title: "裏返して反対側も外す", description: "裏側も同じように身を外して三枚に分けます。腹骨の残りを確認します。", expectedState: "filleted" },
      { id: "saba_bones", title: "小骨を確認する", description: "公開資料では中骨の小骨を骨抜きで取り除く工程が示されています。小骨の残りは人が確認してください。", expectedState: "filleted" },
    ],
  }),
  tai: GuideSchema.parse({
    title: "タイの三枚おろし",
    source: "public_reference",
    sourceLabel: "全国海水養魚協会「魚のおろし方」",
    sourceUrl: "https://www.yoshoku.or.jp/filet/",
    expertReviewed: false,
    steps: [
      { id: "tai_scales", title: "うろこを取る", description: "尾側からうろこを取り、背びれの付け根や腹側も確認します。", expectedState: "whole_fish" },
      { id: "tai_gills", title: "えらの付け根を切る", description: "かま下から腹へ切り込み、えらの付け根を切ります。", expectedState: "whole_fish" },
      { id: "tai_guts", title: "腹を開いて内臓と頭を外す", description: "腹を開いて内臓を取り出し、流水で洗います。その後、両側から胸びれの下に切り込みを入れて頭を外します。", expectedState: "head_removed" },
      { id: "tai_first_side", title: "腹側から身を外す", description: "腹側から中骨に沿って尾まで切り進めます。", expectedState: "unknown" },
      { id: "tai_second_side", title: "背側と反対側を外す", description: "背側も中骨に沿って身を外し、裏側も同じようにおろします。", expectedState: "filleted" },
      { id: "tai_trim", title: "腹骨を確認する", description: "腹骨をすき取ります。身に小骨が残っていないかは人が確認してください。", expectedState: "filleted" },
    ],
  }),
};

export function getReferenceGuide(fishId: GuideRequest["fishId"]): Guide | undefined {
  return REFERENCE_GUIDES[fishId];
}

export function resolveGuideFishId(fishName: string): GuideRequest["fishId"] | undefined {
  const normalizedName = fishName.trim().replace(/[ 　]/g, "").toLowerCase();
  if (["あじ", "アジ", "aji"].includes(normalizedName)) return "aji";
  if (["さば", "サバ", "鯖", "saba"].includes(normalizedName)) return "saba";
  if (["たい", "タイ", "鯛", "tai"].includes(normalizedName)) return "tai";
  if (["はまち", "ハマチ", "ぶり", "ブリ", "hamachi", "buri"].includes(normalizedName)) return "hamachi";
  return undefined;
}

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
    { id: "hamachi", name: "ハマチ" },
    { id: "aji", name: "あじ" },
    { id: "saba", name: "さば" },
    { id: "tai", name: "鯛" },
  ],
  preparations: [
    { id: "three_piece_fillet", name: "三枚おろし" },
  ],
  guideAvailability: "partial",
});

export const MOCK_OBSERVATION: Observation = ObservationSchema.parse({
  source: "mock",
  capturedAt: new Date("2026-10-29T09:00:00.000Z").toISOString(),
  detections: [
    { label: "head", score: 0.82, box: { x: 0.13, y: 0.35, width: 0.19, height: 0.24 } },
    { label: "tail", score: 0.69, box: { x: 0.72, y: 0.37, width: 0.17, height: 0.2 } },
  ],
});
