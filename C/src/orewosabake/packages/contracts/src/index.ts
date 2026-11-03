import { z } from "zod";

export const FishStateSchema = z.enum([
  "whole_fish",
  "head_removed",
  "opened",
  "filleting",
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
  scope: z.literal("edible_portion").default("edible_portion"),
  completionMessage: z.string().default("可食部を骨から外す工程はここまでです。以降の切り分けや調理はガイド対象外です。"),
  // Keep the legacy default so sessions created before source metadata was added still parse.
  source: z.enum(["mock", "public_reference"]).default("mock"),
  sourceLabel: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  expertReviewed: z.boolean().default(false),
});

export const FishIdSchema = z.enum([
  "maguro", "salmon", "hamachi", "aji", "saba", "tai", "ayu", "ebi", "kani", "ika", "tako", "iwashi",
  "buri", "katsuo", "hirame", "karei", "unagi", "anago", "hamo", "tachiuo", "kawahagi", "other_finfish",
]);
export const PreparationIdSchema = z.enum([
  "three_piece_fillet", "five_piece_fillet", "hand_open", "tuna_saku", "skewer_prep", "shrimp_prep", "crab_prep",
  "squid_cleaning", "octopus_cleaning", "eel_prep", "hamo_shop_prepared", "fish_portioning", "kawahagi_prep", "edible_portion",
]);

export const GuideRequestSchema = z.object({
  fishId: FishIdSchema,
  preparationId: PreparationIdSchema,
}).strict();

export const GuideImageAnalysisRequestSchema = z.object({
  fishId: FishIdSchema,
  stepId: z.string().min(1).max(100),
  imageData: z.string()
    .max(2_900_000)
    .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/, "JPEG形式の画像が必要です。"),
}).strict();

const GuideImageAnalysisFieldsSchema = z.object({
  model: z.string().min(1),
  certainty: z.enum(["observed", "uncertain"]),
  visibleParts: z.array(z.enum(["head", "body", "tail"])).max(3),
  stepAssessment: z.object({
    status: z.enum(["likely_complete", "in_progress", "uncertain"]),
    evidence: z.string().max(180),
  }).strict(),
  evidence: z.string().max(240),
  caution: z.string().max(180),
}).strict();

function validateGuideImageAnalysisCertainty(
  response: { certainty: "observed" | "uncertain"; stepAssessment: { status: "likely_complete" | "in_progress" | "uncertain" } },
  context: z.RefinementCtx,
) {
  if (response.certainty === "uncertain" && response.stepAssessment.status !== "uncertain") {
    context.addIssue({
      code: "custom",
      path: ["stepAssessment", "status"],
      message: "画像が不確実な場合、工程判定も不確実である必要があります。",
    });
  }
}

export const GuideImageAnalysisResponseSchema = GuideImageAnalysisFieldsSchema
  .superRefine(validateGuideImageAnalysisCertainty);
export const GuideImageAnalysisResultSchema = GuideImageAnalysisFieldsSchema
  .omit({ model: true })
  .superRefine(validateGuideImageAnalysisCertainty);

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
  fish: z.array(z.object({ id: FishIdSchema, name: z.string(), guideAvailable: z.boolean() })),
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
export type FishId = z.infer<typeof FishIdSchema>;
export type GuideRequest = z.infer<typeof GuideRequestSchema>;
export type GuideImageAnalysisRequest = z.infer<typeof GuideImageAnalysisRequestSchema>;
export type GuideImageAnalysisResponse = z.infer<typeof GuideImageAnalysisResponseSchema>;
export type AdvanceGuideStepRequest = z.infer<typeof AdvanceGuideStepRequestSchema>;
export type GuideSession = z.infer<typeof GuideSessionSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type ModelStatus = z.infer<typeof ModelStatusSchema>;
export type OrientationConfig = z.infer<typeof OrientationConfigSchema>;
export type Detection = z.infer<typeof DetectionSchema>;
export type Observation = z.infer<typeof ObservationSchema>;

export const REFERENCE_GUIDES: Partial<Record<GuideRequest["fishId"], Guide>> = {
  maguro: GuideSchema.parse({
    title: "マグロの柵からの下ごしらえ",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「鮪のさばき方：柵取り」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1066/",
    expertReviewed: false,
    steps: [
      { id: "maguro_portion", title: "柵を用意する", description: "マグロは丸ごとではなく、魚屋で柵にしてもらったものから始めよう。大きな魚の解体はお店にお願いしてね。", expectedState: "unknown" },
      { id: "maguro_wipe", title: "表面の水分を取る", description: "清潔なペーパーで表面の水分をやさしく押さえるよ。まな板と包丁も清潔にしておこう。", expectedState: "whole_fish" },
      { id: "maguro_bloodline", title: "血合いを切り分ける", description: "血合いが付いている場合は、境目を見ながら少しずつ切り分けるよ。柵が滑らないように手を添えてね。", expectedState: "opened" },
      { id: "maguro_saku", title: "食べやすい柵に整える", description: "筋目を見て、刺身に使いやすい形に切り分けるよ。力任せに押し切らず、包丁をまっすぐ動かそう。", expectedState: "filleted" },
      { id: "maguro_check", title: "骨や筋を確認する", description: "腹骨や筋が残っていないか目で確認しよう。生食する場合は、信頼できる販売店の生食用表示と保存方法に従ってね。", expectedState: "filleted" },
    ],
  }),
  salmon: GuideSchema.parse({
    title: "サーモンの三枚おろし",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「鮭のさばき方」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1038/",
    expertReviewed: false,
    steps: [
      { id: "salmon_scale", title: "うろこを取る", description: "尾から頭に向かって、残りやすいヒレの近くまでうろこを取ろう。身を傷つけないよう、包丁を寝かせてね。", expectedState: "whole_fish" },
      { id: "salmon_guts", title: "腹を開いて内臓を外す", description: "腹を開いて内臓を取り出し、血合いを洗い流そう。水気をしっかりふき取るよ。", expectedState: "opened" },
      { id: "salmon_head", title: "頭を外す", description: "胸びれの付け根から中骨まで切り込みを入れ、裏返して反対側も切るよ。骨が硬くて進まないときは無理をしないでね。", expectedState: "head_removed" },
      { id: "salmon_first_side", title: "片側の身を外す", description: "腹側と背側から中骨に沿って切り込み、尾側から身をはがしていこう。刃先が見える範囲で少しずつ進めるよ。", expectedState: "filleting" },
      { id: "salmon_second_side", title: "裏返して反対側も外す", description: "魚を裏返し、同じように反対側の身を外すよ。", expectedState: "filleted" },
      { id: "salmon_bones", title: "腹骨と小骨を確認する", description: "腹骨を取り、身の小骨を目と指で確認しよう。加熱用なら十分に火を通してね。", expectedState: "filleted" },
    ],
  }),
  hamachi: GuideSchema.parse({
    title: "ハマチの三枚おろし",
    source: "public_reference",
    sourceLabel: "全国海水養魚協会「魚のおろし方」",
    sourceUrl: "https://www.yoshoku.or.jp/filet/",
    expertReviewed: false,
    steps: [
      { id: "hamachi_scales", title: "うろこを取る", description: "よーし、うろこ取りだよ！まずは体をぬらしてから、うろこを取ろう。ヒレの近くは取り残しやすいから、最後に目でしっかりチェックしてね！", expectedState: "whole_fish" },
      { id: "hamachi_gills", title: "えらを外す", description: "えらの付け根とかまの下側を切り、反対側も同じように外します。", expectedState: "whole_fish" },
      { id: "hamachi_guts", title: "腹を開いて洗う", description: "腹側を尾の近くまで開き、えらと内臓を取り出します。流水で血や汚れを洗い、水気をふき取ります。", expectedState: "opened" },
      { id: "hamachi_head", title: "頭を外す", description: "胸びれの下から頭の付け根へ切り進め、頭を外します。硬くて進まない場合は力をかけ続けず、作業を止めてください。", expectedState: "head_removed" },
      { id: "hamachi_belly_cut", title: "腹側に切り込みを入れる", description: "腹側を手前に置き、尻びれから尾まで切り込みを入れます。魚が安定し、手元が見える状態で進めます。", expectedState: "head_removed" },
      { id: "hamachi_first_side", title: "片側の身を外す", description: "背側にも中骨に沿って切り込みを入れ、尾の付け根から肩口へ身を外します。", expectedState: "filleting" },
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
      { id: "aji_first_side", title: "片側の身を外す", description: "腹を手前にし、頭側から中骨に沿って尾まで切り進めます。", expectedState: "filleting" },
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
      { id: "saba_belly_cut", title: "腹側から身を外す", description: "腹側から中骨の上を尾まで切り開きます。", expectedState: "filleting" },
      { id: "saba_back_cut", title: "背側に切り込みを入れる", description: "背びれの上に沿って尾側から頭側へ切り込みを入れます。", expectedState: "filleting" },
      { id: "saba_first_side", title: "片側の身を外して腹骨を取る", description: "尾の付け根に切り目を入れ、中骨の上で片側の身を切り離します。腹骨をすき取ります。", expectedState: "filleting" },
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
      { id: "tai_first_side", title: "腹側から身を外す", description: "腹側から中骨に沿って尾まで切り進めます。", expectedState: "filleting" },
      { id: "tai_second_side", title: "背側と反対側を外す", description: "背側も中骨に沿って身を外し、裏側も同じようにおろします。", expectedState: "filleted" },
      { id: "tai_trim", title: "腹骨を確認する", description: "腹骨をすき取ります。身に小骨が残っていないかは人が確認してください。", expectedState: "filleted" },
    ],
  }),
  ayu: GuideSchema.parse({
    title: "鮎の下処理と串打ち",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「鮎のさばき方：串打ち」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1011/",
    expertReviewed: false,
    steps: [
      { id: "ayu_check", title: "鮎と道具を確認する", description: "鮎を安定して置き、竹串と塩を用意しよう。魚が滑る、刃先が見えにくいときは先に整えてね。", expectedState: "whole_fish" },
      { id: "ayu_clean", title: "腹の汚れを洗う", description: "腹を軽く押して内容物を出し、水で洗ってぬめりを取るよ。強く押して身をつぶさないようにしよう。", expectedState: "opened" },
      { id: "ayu_skewer", title: "串を打つ", description: "目の後ろから串を入れ、身を波打たせるように通すよ。串先が手に向かないよう注意してね。", expectedState: "filleting" },
      { id: "ayu_salt", title: "化粧塩をして仕上げる", description: "ヒレに塩をつけ、必要なら添え串で形を整えるよ。両面に塩をふったら下処理完了！", expectedState: "filleted" },
    ],
  }),
  ebi: GuideSchema.parse({
    title: "エビの下処理",
    source: "public_reference",
    sourceLabel: "魚食普及推進センター「エビのさばき方」",
    sourceUrl: "https://osakana.suisankai.or.jp/s-other/5511",
    expertReviewed: false,
    steps: [
      { id: "ebi_thaw", title: "冷蔵状態で準備する", description: "冷凍エビは表示に従って冷蔵庫などで解凍しよう。常温に長く置かず、作業する分だけ出すよ。", expectedState: "whole_fish" },
      { id: "ebi_shell", title: "殻をむく", description: "頭を外し、尾を残す場合は尾の殻だけ残して殻をむこう。殻のトゲで指を傷つけないよう気をつけてね。", expectedState: "opened" },
      { id: "ebi_vein", title: "背わたを取る", description: "背に浅く切り込みを入れ、黒い背わたを取り除くよ。見えにくいときは竹串を使ってね。", expectedState: "filleting" },
      { id: "ebi_wash", title: "洗って水気を取る", description: "さっと洗い、ペーパーで水気を取ろう。生食用表示がないものは加熱してね。", expectedState: "filleted" },
    ],
  }),
  kani: GuideSchema.parse({
    title: "カニの食べる部分を取り分ける",
    source: "public_reference",
    sourceLabel: "魚食普及推進センター「カニのさばき方」",
    sourceUrl: "https://osakana.suisankai.or.jp/s-other/7638",
    expertReviewed: false,
    steps: [
      { id: "kani_cooked", title: "加熱済みのカニを用意する", description: "この手順は十分に加熱されたカニ用だよ。生きたカニや種類が分からないカニは無理に扱わず、お店に相談してね。", expectedState: "unknown" },
      { id: "kani_apron", title: "腹側のふたを外す", description: "腹側の三角形のふたを持ち上げて外そう。殻の端で手を切らないよう、ふきんで押さえると安心だよ。", expectedState: "opened" },
      { id: "kani_shell", title: "甲羅を外す", description: "甲羅をゆっくりはがし、食べないえらなどを取り除くよ。殻が固いときは無理にこじらないでね。", expectedState: "filleting" },
      { id: "kani_legs", title: "脚と胴を分ける", description: "脚を関節で分け、胴は食べやすい大きさに割るよ。殻片が身に残っていないか確認しよう。", expectedState: "filleted" },
    ],
  }),
  ika: GuideSchema.parse({
    title: "イカの下処理",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「するめいかのさばき方」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/2038/",
    expertReviewed: false,
    steps: [
      { id: "ika_separate", title: "胴と足を分ける", description: "胴の中に指を入れ、足を持ってゆっくり引き抜くよ。内臓を破らないように、軟骨も一緒に外してね。", expectedState: "opened" },
      { id: "ika_fin", title: "エンペラと皮を外す", description: "エンペラをはがし、滑らないようペーパーを使って皮をむこう。", expectedState: "opened" },
      { id: "ika_open", title: "胴を開いて軟骨を取る", description: "胴を開き、軟骨や残った内臓を取り除くよ。墨袋をつぶさないよう、ゆっくり進めよう。", expectedState: "filleting" },
      { id: "ika_arms", title: "目・くちばし・墨袋を外す", description: "足から内臓を分け、目とくちばし、墨袋を取り除くよ。包丁を使う部分は手元をよく見てね。", expectedState: "filleted" },
      { id: "ika_check", title: "洗って仕上げる", description: "水でさっと洗い、水気をふき取るよ。生で食べる場合は販売店の表示や鮮度管理に従ってね。", expectedState: "filleted" },
    ],
  }),
  tako: GuideSchema.parse({
    title: "タコの下処理",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「蛸のさばき方」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/2043/",
    expertReviewed: false,
    steps: [
      { id: "tako_prepared", title: "下処理済みのタコを用意する", description: "生きたタコは吸盤や動きで扱いにくいので、初心者は魚屋で下処理済みのものを選ぼう。", expectedState: "unknown" },
      { id: "tako_head", title: "頭の内側を確認する", description: "丸ごとの下処理済みを使う場合は、頭の内側に内臓が残っていないか確認しよう。迷ったら購入店に確認してね。", expectedState: "opened" },
      { id: "tako_beak", title: "口を取り除く", description: "足の付け根の中心にある口を取り除くよ。硬い部分が残らないように確認しよう。", expectedState: "filleting" },
      { id: "tako_clean", title: "汚れを落として確認する", description: "ぬめりや汚れを落として洗い、水気を取るよ。食べられる部分が頭や足から分けられているか、目で確認しよう。", expectedState: "filleted" },
    ],
  }),
  iwashi: GuideSchema.parse({
    title: "イワシの手開き",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「鰯のさばき方：手開き」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1020/",
    expertReviewed: false,
    steps: [
      { id: "iwashi_head", title: "頭と内臓を外す", description: "頭の付け根に親指を入れて頭を折り、内臓と一緒に外そう。指先を骨に沿わせてゆっくりね。", expectedState: "opened" },
      { id: "iwashi_clean", title: "腹の血合いを洗う", description: "腹の中を流水で洗い、ペーパーで水気を取るよ。", expectedState: "opened" },
      { id: "iwashi_bone", title: "中骨から身を外す", description: "中骨に沿って親指を入れ、身と骨を少しずつ分けよう。身を強く押しつぶさないでね。", expectedState: "filleting" },
      { id: "iwashi_finish", title: "中骨を外して確認する", description: "尾側から中骨を腹側へはがし、反対側の背びれを外すよ。小骨がないか確認して仕上げ！", expectedState: "filleted" },
    ],
  }),
  buri: GuideSchema.parse({
    title: "ブリの三枚おろし",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「鰤のさばき方」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1063/",
    expertReviewed: false,
    steps: [
      { id: "buri_scale", title: "うろこを取る", description: "尾から頭に向けてうろこを取り、ヒレの近くも確認しよう。", expectedState: "whole_fish" },
      { id: "buri_guts", title: "頭と内臓を外す", description: "胸びれの後ろから切り込み、腹を開いて内臓を取り出すよ。骨が硬いときは無理に押さず、魚屋に頼んでね。", expectedState: "opened" },
      { id: "buri_wash", title: "血合いを洗う", description: "腹の血合いを洗い、水気をふき取ろう。", expectedState: "opened" },
      { id: "buri_first_side", title: "片側の身を外す", description: "尾を左に置き、腹側と背側から中骨に沿って切り込み、片身を外すよ。", expectedState: "filleting" },
      { id: "buri_second_side", title: "裏返して反対側を外す", description: "裏返して同じように身を外し、腹骨をすき取ろう。", expectedState: "filleted" },
      { id: "buri_check", title: "骨を確認する", description: "骨抜きや指で小骨の残りを確認してね。", expectedState: "filleted" },
    ],
  }),
  katsuo: GuideSchema.parse({
    title: "カツオの三枚おろし",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「鰹のさばき方」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1025/",
    expertReviewed: false,
    steps: [
      { id: "katsuo_scale", title: "うろこを取る", description: "包丁を寝かせて、尾からうろこをすき取ろう。飛び散りやすいからゆっくりね。", expectedState: "whole_fish" },
      { id: "katsuo_guts", title: "頭と内臓を外す", description: "腹を開いて内臓を外し、血合いを洗うよ。魚が大きくて不安なら購入店で処理してもらおう。", expectedState: "opened" },
      { id: "katsuo_wash", title: "水気をふき取る", description: "うろこと腹の血合いを洗い流したら、水気をふき取ろう。", expectedState: "opened" },
      { id: "katsuo_first_side", title: "片側の身を外す", description: "腹側と背側から中骨に沿って切り込み、尾側から身をはがしていくよ。", expectedState: "filleting" },
      { id: "katsuo_second_side", title: "反対側の身を外す", description: "裏返して反対側も同じように中骨から外そう。", expectedState: "filleted" },
      { id: "katsuo_check", title: "血合いと骨を確認する", description: "血合いや小骨が残っていないか確認してね。生食は販売店の表示と保存方法を守ろう。", expectedState: "filleted" },
    ],
  }),
  hirame: GuideSchema.parse({
    title: "ヒラメの五枚おろし",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「鮃のさばき方」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1060/",
    expertReviewed: false,
    steps: [
      { id: "hirame_clean", title: "ぬめりとうろこを取る", description: "たわしなどでぬめりを落とし、うろこをすき引きするよ。難しいときは魚屋に頼んでね。", expectedState: "whole_fish" },
      { id: "hirame_head", title: "頭と内臓を外す", description: "胸びれの下から中骨まで切り、裏返して頭と内臓を外すよ。", expectedState: "opened" },
      { id: "hirame_clean_belly", title: "血合いを洗う", description: "腹の血合いを洗い、水気をふき取ろう。", expectedState: "opened" },
      { id: "hirame_top_fillets", title: "表側の身を2枚外す", description: "尾側を手前にし、中心線に沿って包丁を入れるよ。中骨に沿って左右の身を少しずつ外そう。", expectedState: "filleting" },
      { id: "hirame_bottom_fillets", title: "裏側の身も2枚外す", description: "裏返して同じように中心から左右の身を外すよ。平たい魚は三枚ではなく、身4枚と中骨に分かれるよ。", expectedState: "filleted" },
      { id: "hirame_check", title: "腹骨と縁側を整える", description: "腹骨を取り、身に骨やうろこが残っていないか確認しよう。", expectedState: "filleted" },
    ],
  }),
  karei: GuideSchema.parse({
    title: "カレイの五枚おろし",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「鰈のさばき方」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1027/",
    expertReviewed: false,
    steps: [
      { id: "karei_scale", title: "うろこを取る", description: "ヒレのきわまで、うろこを丁寧に取ろう。", expectedState: "whole_fish" },
      { id: "karei_guts", title: "腹を開いて内臓を外す", description: "腹に切り込みを入れて内臓を外し、血合いを洗って水気をふき取るよ。", expectedState: "opened" },
      { id: "karei_outline", title: "胸びれと尾に切り目を入れる", description: "身を安定させ、胸びれの下と尾に切り目を入れるよ。", expectedState: "opened" },
      { id: "karei_top", title: "表側の身を2枚外す", description: "尾側を手前にし、中心線と縁側に沿って切り込み、中骨から身を外そう。", expectedState: "filleting" },
      { id: "karei_bottom", title: "裏側の身も2枚外す", description: "裏返して同じように身を外すよ。平たいカレイは身4枚と中骨に分ける五枚おろしだよ。", expectedState: "filleted" },
      { id: "karei_check", title: "腹骨と小骨を確認する", description: "腹骨を取り、骨の残りを確認して仕上げよう。", expectedState: "filleted" },
    ],
  }),
  unagi: GuideSchema.parse({
    title: "ウナギの下処理済み身を整える",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「鰻のさばき方：串打ち」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1022/",
    expertReviewed: false,
    steps: [
      { id: "unagi_prepared", title: "魚屋で開いたウナギを用意する", description: "生きたウナギを自宅で締めたり開いたりする手順ではないよ。下処理済みの身を魚屋で用意してもらおう。", expectedState: "unknown" },
      { id: "unagi_rinse", title: "身を確認して水気を取る", description: "骨や汚れが残っていないか確認し、必要なら軽く洗って水気をふき取るよ。", expectedState: "opened" },
      { id: "unagi_bone", title: "小骨を確認する", description: "背骨や腹骨が残っていないか目で確認するよ。骨が残っている場合は魚屋に処理を頼んでね。", expectedState: "filleting" },
      { id: "unagi_portion", title: "調理しやすい大きさにする", description: "身を安定させて、料理に使う長さに切り分けよう。滑る場合は無理せず作業を止めてね。", expectedState: "filleted" },
    ],
  }),
  anago: GuideSchema.parse({
    title: "アナゴの下処理",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「穴子のさばき方」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1009/",
    expertReviewed: false,
    steps: [
      { id: "anago_prepared", title: "魚屋で開いてもらう", description: "アナゴは目打ちなどで固定して開く工程が必要だよ。慣れていない場合は、自宅で無理に開かず魚屋に頼もう。", expectedState: "unknown" },
      { id: "anago_check", title: "開いた身を確認する", description: "身に内臓や血が残っていないか確認し、店の案内に従って洗って水気を取ろう。", expectedState: "opened" },
      { id: "anago_bone", title: "中骨を確認する", description: "骨が身からきれいに外れているか確認するよ。残っている場合は店で取り除いてもらおう。", expectedState: "filleting" },
      { id: "anago_portion", title: "ヒレを整えて切り分ける", description: "ヒレや食べにくい部分を確認し、料理に使いやすい大きさに切ろう。", expectedState: "filleted" },
    ],
  }),
  hamo: GuideSchema.parse({
    title: "ハモの骨切り済み身を使う",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「鱧のさばき方」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1058/",
    expertReviewed: false,
    steps: [
      { id: "hamo_shop", title: "骨切り済みを魚屋で用意する", description: "ハモの骨切りは専用包丁で細かな小骨を切る専門技術だよ。丸ごとのハモを家庭で骨切りせず、魚屋に処理を頼んでね。", expectedState: "unknown" },
      { id: "hamo_check", title: "骨切りの状態を確認する", description: "骨切り済みの表示を確認し、骨が気になる場合は販売店に聞こう。骨が残る身を無理に食べないでね。", expectedState: "opened" },
      { id: "hamo_portion", title: "食べやすい長さに切る", description: "皮を下にして身を安定させ、料理に使う長さに切り分けよう。", expectedState: "filleting" },
      { id: "hamo_cook", title: "十分に加熱する", description: "湯引きや焼きなど料理に合わせて加熱しよう。骨の状態や加熱方法に迷ったら購入店の案内を確認してね。", expectedState: "filleted" },
    ],
  }),
  tachiuo: GuideSchema.parse({
    title: "太刀魚の切り身にする",
    source: "public_reference",
    sourceLabel: "日本さばけるプロジェクト「太刀魚のさばき方」",
    sourceUrl: "https://sabakeru.uminohi.jp/sabakeru_channel/1048/",
    expertReviewed: false,
    steps: [
      { id: "tachiuo_head", title: "頭と内臓を外す", description: "ヒレを持って魚を安定させ、頭を外してから腹を開き内臓を取るよ。太刀魚は長いので、まな板からはみ出さないよう切り分けてね。", expectedState: "opened" },
      { id: "tachiuo_clean", title: "血合いを洗う", description: "腹の血合いを洗い、水気をしっかりふき取ろう。", expectedState: "opened" },
      { id: "tachiuo_sections", title: "料理に合わせて切り分ける", description: "まず扱いやすい長さの筒切りにするよ。鋭い背びれに注意し、魚が滑らない状態で作業してね。", expectedState: "filleting" },
      { id: "tachiuo_fillets", title: "中骨に沿って身を外す", description: "腹側と背側から中骨に沿って身を外し、裏返して反対側も同じように進めよう。", expectedState: "filleted" },
      { id: "tachiuo_check", title: "腹骨と小骨を確認する", description: "腹骨を取り、小骨が残っていないか確かめてね。", expectedState: "filleted" },
    ],
  }),
  kawahagi: GuideSchema.parse({
    title: "カワハギの皮むきと三枚おろし",
    source: "public_reference",
    sourceLabel: "東京都中央卸売市場「カワハギのさばき方」",
    sourceUrl: "https://www.shijou.metro.tokyo.lg.jp/ja/about/shoku/sabakikata/kawahagi",
    expertReviewed: false,
    steps: [
      { id: "kawahagi_spines", title: "角とヒレを処理する", description: "角や鋭いヒレに注意し、魚屋で処理済みのものを使うと安全だよ。自分で行う場合は魚をしっかり固定し、無理をしないでね。", expectedState: "whole_fish" },
      { id: "kawahagi_skin", title: "皮をむく", description: "頭側の皮に切れ目を入れ、皮をゆっくり尾側へはがすよ。滑る場合はペーパーを使おう。", expectedState: "opened" },
      { id: "kawahagi_guts", title: "肝を傷つけず内臓を外す", description: "肝をつぶさないよう内臓を外し、腹の中を洗って水気を取るよ。肝の状態が不安なら食べずに購入店へ確認してね。", expectedState: "opened" },
      { id: "kawahagi_head", title: "頭を外して身を開く", description: "頭を外し、中骨に沿って片側ずつ身を外そう。", expectedState: "filleting" },
      { id: "kawahagi_check", title: "薄皮と骨を確認する", description: "身の薄皮や小骨が残っていないか確認して仕上げよう。", expectedState: "filleted" },
    ],
  }),
  other_finfish: GuideSchema.parse({
    title: "一般的な魚の三枚おろし",
    source: "public_reference",
    sourceLabel: "全国海水養魚協会「魚のおろし方」（ブリ・ハマチ、タイ）",
    sourceUrl: "https://www.yoshoku.or.jp/filet/",
    expertReviewed: false,
    steps: [
      { id: "other_finfish_identify", title: "魚種と手順を確認する", description: "このガイドは、一般的な体型の魚を三枚おろしにする基本手順だよ。フグなど毒や特殊な処理が必要な魚、ヒラメ・カレイなど平たい魚、ウナギ・アナゴ・ハモ、イカ・タコ・貝・エビ・カニは対象外。魚種が分からないときや、この方法でよいか迷うときは捌かず、購入店に相談してね。", expectedState: "unknown" },
      { id: "other_finfish_scales", title: "うろこを取る", description: "うろこがある魚は、体を水でぬらしてから尾側から取ろう。ヒレの付け根も確認してね。うろこがない魚はこの工程を飛ばしてね。", expectedState: "whole_fish" },
      { id: "other_finfish_gills", title: "えらの付け根を切る", description: "えらがある魚は、えらの付け根と、かまの下に切り込みを入れるよ。反対側も同じように。魚が動く、刃先が見えないときは作業を止めてね。", expectedState: "whole_fish" },
      { id: "other_finfish_guts", title: "腹を開いて内臓を取り出す", description: "尾側まで腹を開き、えらと内臓を外すよ。流水で血や汚れを洗い、水気をふき取ろう。", expectedState: "opened" },
      { id: "other_finfish_head", title: "頭を外す", description: "胸びれの下から頭の付け根へ包丁を入れて外すよ。骨が硬くて進まないときは、無理に押さないでね。", expectedState: "head_removed" },
      { id: "other_finfish_belly_cut", title: "腹側に切り込みを入れる", description: "腹側を手前にして、尻びれから尾まで中骨に沿って切り込みを入れるよ。魚が安定していることを確かめてね。", expectedState: "head_removed" },
      { id: "other_finfish_back_cut", title: "背側に切り込みを入れる", description: "背側も中骨に沿って切り込みを入れるよ。手元が見えない、魚が滑るときは作業を止めてね。", expectedState: "head_removed" },
      { id: "other_finfish_first_side", title: "片側の身を外す", description: "尾の付け根から中骨の上へ包丁を入れ、頭側へ進めて片側の身を外すよ。刃先が見えない、魚が滑るときは止めよう。", expectedState: "filleting" },
      { id: "other_finfish_second_side", title: "裏返して反対側を外す", description: "魚を裏返し、同じように中骨に沿って反対側の身を外すよ。", expectedState: "filleted" },
      { id: "other_finfish_check", title: "三枚になったか確認する", description: "身2枚と中骨1枚に分かれたら基本の三枚おろしは完了だよ。骨の残りや食べられる状態は、自分の目で確認してね。", expectedState: "filleted" },
    ],
  }),
};

const PREPARATION_BY_FISH: Record<GuideRequest["fishId"], GuideRequest["preparationId"]> = {
  maguro: "tuna_saku",
  salmon: "three_piece_fillet",
  hamachi: "three_piece_fillet",
  aji: "three_piece_fillet",
  saba: "three_piece_fillet",
  tai: "three_piece_fillet",
  ayu: "skewer_prep",
  ebi: "shrimp_prep",
  kani: "crab_prep",
  ika: "squid_cleaning",
  tako: "octopus_cleaning",
  iwashi: "hand_open",
  buri: "three_piece_fillet",
  katsuo: "three_piece_fillet",
  hirame: "five_piece_fillet",
  karei: "five_piece_fillet",
  unagi: "eel_prep",
  anago: "eel_prep",
  hamo: "hamo_shop_prepared",
  tachiuo: "fish_portioning",
  kawahagi: "kawahagi_prep",
  other_finfish: "three_piece_fillet",
};

// A guide is served only through the step that reaches separated edible flesh.
// Tuna saku and whole-grilled ayu procedures do not guide bone removal.
const EDIBLE_PORTION_STOP_STEP_BY_FISH: Partial<Record<GuideRequest["fishId"], string>> = {
  salmon: "salmon_bones",
  hamachi: "hamachi_check",
  aji: "aji_trim",
  saba: "saba_bones",
  tai: "tai_trim",
  ebi: "ebi_wash",
  kani: "kani_legs",
  ika: "ika_check",
  tako: "tako_clean",
  iwashi: "iwashi_finish",
  buri: "buri_check",
  katsuo: "katsuo_check",
  hirame: "hirame_check",
  karei: "karei_check",
  unagi: "unagi_bone",
  anago: "anago_bone",
  hamo: "hamo_check",
  tachiuo: "tachiuo_check",
  kawahagi: "kawahagi_check",
  other_finfish: "other_finfish_check",
};

export function getPreparationIdForFish(fishId: GuideRequest["fishId"]): GuideRequest["preparationId"] {
  return PREPARATION_BY_FISH[fishId];
}

export function getReferenceGuide(
  fishId: GuideRequest["fishId"],
  preparationId?: GuideRequest["preparationId"],
): Guide | undefined {
  if (preparationId && preparationId !== "edible_portion" && PREPARATION_BY_FISH[fishId] !== preparationId) return undefined;
  const guide = REFERENCE_GUIDES[fishId];
  const stopStepId = EDIBLE_PORTION_STOP_STEP_BY_FISH[fishId];
  if (!guide || !stopStepId) return undefined;
  const stopIndex = guide.steps.findIndex((step) => step.id === stopStepId);
  if (stopIndex < 0) return undefined;
  return GuideSchema.parse({ ...guide, steps: guide.steps.slice(0, stopIndex + 1) });
}

export function resolveGuideFishId(fishName: string): GuideRequest["fishId"] | undefined {
  const normalizedName = fishName.trim().replace(/[ 　]/g, "").toLowerCase();
  const names: Record<string, GuideRequest["fishId"]> = {
    "まぐろ": "maguro", "マグロ": "maguro", "鮪": "maguro", tuna: "maguro",
    "さーもん": "salmon", "サーモン": "salmon", "さけ": "salmon", "鮭": "salmon", salmon: "salmon",
    "はまち": "hamachi", "ハマチ": "hamachi", hamachi: "hamachi",
    "あじ": "aji", "アジ": "aji", "鯵": "aji", aji: "aji",
    "さば": "saba", "サバ": "saba", "鯖": "saba", saba: "saba",
    "たい": "tai", "タイ": "tai", "鯛": "tai", tai: "tai",
    "あゆ": "ayu", "アユ": "ayu", "鮎": "ayu", ayu: "ayu",
    "えび": "ebi", "エビ": "ebi", "海老": "ebi", ebi: "ebi", shrimp: "ebi",
    "かに": "kani", "カニ": "kani", "蟹": "kani", kani: "kani", crab: "kani",
    "いか": "ika", "イカ": "ika", "烏賊": "ika", ika: "ika", squid: "ika",
    "たこ": "tako", "タコ": "tako", "蛸": "tako", tako: "tako", octopus: "tako",
    "いわし": "iwashi", "イワシ": "iwashi", "鰯": "iwashi", iwashi: "iwashi", sardine: "iwashi",
    "ぶり": "buri", "ブリ": "buri", "鰤": "buri", buri: "buri",
    "かつお": "katsuo", "カツオ": "katsuo", "鰹": "katsuo", katsuo: "katsuo", bonito: "katsuo",
    "ひらめ": "hirame", "ヒラメ": "hirame", "鮃": "hirame", hirame: "hirame",
    "かれい": "karei", "カレイ": "karei", "鰈": "karei", karei: "karei",
    "うなぎ": "unagi", "ウナギ": "unagi", "鰻": "unagi", unagi: "unagi",
    "あなご": "anago", "アナゴ": "anago", "穴子": "anago", anago: "anago",
    "はも": "hamo", "ハモ": "hamo", "鱧": "hamo", hamo: "hamo",
    "たちうお": "tachiuo", "タチウオ": "tachiuo", "太刀魚": "tachiuo", tachiuo: "tachiuo",
    "かわはぎ": "kawahagi", "カワハギ": "kawahagi", "鮍": "kawahagi", kawahagi: "kawahagi",
  };
  return names[normalizedName];
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
    { id: "maguro", name: "マグロ", guideAvailable: false },
    { id: "salmon", name: "サーモン", guideAvailable: true },
    { id: "hamachi", name: "ハマチ", guideAvailable: true },
    { id: "aji", name: "あじ", guideAvailable: true },
    { id: "saba", name: "さば", guideAvailable: true },
    { id: "tai", name: "鯛", guideAvailable: true },
    { id: "ayu", name: "鮎", guideAvailable: false },
    { id: "ebi", name: "エビ", guideAvailable: true },
    { id: "kani", name: "カニ", guideAvailable: true },
    { id: "ika", name: "イカ", guideAvailable: true },
    { id: "tako", name: "タコ", guideAvailable: true },
    { id: "iwashi", name: "イワシ", guideAvailable: true },
    { id: "buri", name: "ぶり", guideAvailable: true },
    { id: "katsuo", name: "カツオ", guideAvailable: true },
    { id: "hirame", name: "ヒラメ", guideAvailable: true },
    { id: "karei", name: "カレイ", guideAvailable: true },
    { id: "unagi", name: "ウナギ", guideAvailable: true },
    { id: "anago", name: "アナゴ", guideAvailable: true },
    { id: "hamo", name: "はも", guideAvailable: true },
    { id: "tachiuo", name: "太刀魚", guideAvailable: true },
    { id: "kawahagi", name: "カワハギ", guideAvailable: true },
    { id: "other_finfish", name: "その他の魚", guideAvailable: true },
  ],
  preparations: [
    { id: "edible_portion", name: "可食部を骨から外す" },
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
