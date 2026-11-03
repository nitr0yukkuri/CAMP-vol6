import {
  GuideImageAnalysisResponseSchema,
  GuideImageAnalysisResultSchema,
  GuideSalmonImageAnalysisResponseSchema,
  GuideSalmonImageAnalysisResultSchema,
  type GuideStep,
  type FishId,
  type GuideImageAnalysisResponse,
} from "@orewosabake/contracts";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const fishStateAssessmentSchema = {
  type: "OBJECT",
  properties: {
    state: { type: "STRING", enum: ["whole_fish", "head_removed", "opened", "filleting", "filleted", "unknown"] },
    evidence: { type: "STRING" },
  },
  required: ["state", "evidence"],
  propertyOrdering: ["state", "evidence"],
} as const;

function createResponseSchema(includeFishState: boolean) {
  const properties = {
    certainty: { type: "STRING", enum: ["observed", "uncertain"] },
    visibleParts: { type: "ARRAY", items: { type: "STRING", enum: ["head", "body", "tail"] } },
    ...(includeFishState ? { fishStateAssessment: fishStateAssessmentSchema } : {}),
    stepAssessment: {
      type: "OBJECT",
      properties: {
        status: { type: "STRING", enum: ["likely_complete", "in_progress", "uncertain"] },
        evidence: { type: "STRING" },
      },
      required: ["status", "evidence"],
      propertyOrdering: ["status", "evidence"],
    },
    evidence: { type: "STRING" },
    caution: { type: "STRING" },
  };
  const required = [
    "certainty",
    "visibleParts",
    ...(includeFishState ? ["fishStateAssessment"] : []),
    "stepAssessment",
    "evidence",
    "caution",
  ];
  return { type: "OBJECT", properties, required, propertyOrdering: required };
}

export class GeminiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function analyzeGuideImage(options: {
  apiKey: string | undefined;
  model: string | undefined;
  fishId: FishId;
  step: GuideStep;
  baselineImageData?: string;
  imageData: string;
}): Promise<GuideImageAnalysisResponse> {
  if (!options.apiKey) {
    throw new GeminiRequestError(503, "GEMINI_NOT_CONFIGURED", "Gemini APIキーが設定されていません。.envのGEMINI_API_KEYを確認してください。");
  }

  const [header, imageBase64] = options.imageData.split(",", 2);
  if (header !== "data:image/jpeg;base64" || !imageBase64) {
    throw new GeminiRequestError(422, "INVALID_IMAGE", "JPEG画像を送信してください。");
  }
  const baselineBase64 = options.baselineImageData?.split(",", 2)[1];
  if (options.baselineImageData && !baselineBase64) {
    throw new GeminiRequestError(422, "INVALID_BASELINE_IMAGE", "工程開始時のJPEG画像を確認してください。");
  }

  const isSalmon = options.fishId === "salmon";
  const prompt = [
    "あなたは魚の調理工程を補助する画像確認役です。回答は日本語で、指定されたJSON形式だけにしてください。",
    "画像から直接見える事実だけを短く述べてください。魚種、鮮度、食用安全性、骨の完全な除去を保証してはいけません。",
    "visiblePartsでは画像内にはっきり見える頭・体・尾だけを返してください。",
    ...(isSalmon ? [
      "fishStateAssessmentでは魚体の見た目の状態を工程完了と独立して判定してください。whole_fish=丸のまま、opened=頭が付いていて腹が開かれた状態、head_removed=頭が外れた状態、filleting=片側の身が外れて中骨が見える状態、filleted=両側の身が骨から外れた状態、unknown=画像だけでは区別できない状態です。複数に当てはまる時は最も進んだ状態を返してください（filleted > filleting > head_removed > opened > whole_fish）。",
      "fishStateAssessment.stateは画像内の魚体形状を根拠にし、現在工程や目標状態から推測してはいけません。証拠が足りなければunknownにしてください。evidenceには状態の根拠を短く記載してください。",
    ] : []),
    "stepAssessment.status は、この画像の見た目が現在の工程をどこまで示しているかを慎重に推定してください。",
    ...(baselineBase64
      ? ["画像1は工程開始時、画像2は現在です。2枚の対象が同じ魚か確かめ、工程完了を示す変化が明瞭な時だけlikely_completeにしてください。明確に未完了と分かる時だけin_progress、それ以外はuncertainです。"]
      : ["likely_complete は工程完了を示す明確な見た目の証拠がある場合だけ、in_progress は明確に未完了と分かる場合だけにしてください。それ以外は uncertain にしてください。"]),
    ...(isSalmon ? [
      "うろこの残りや骨・小骨の完全な除去、指で触れて確認する作業は画像だけでは証明できません。これらの工程をlikely_completeにしてはいけません。目標状態ラベルだけから完了を推測してはいけません。",
      "不鮮明、隠れている、画角外など画像全体を判断できない場合はcertaintyをuncertain、fishStateAssessment.stateをunknown、stepAssessment.statusをuncertainにしてください。",
    ] : [
      "うろこ取りや小骨確認など、画像だけで作業結果を確かめられない工程は uncertain にしてください。期待状態のラベルだけから完了を推測してはいけません。",
      "不鮮明、隠れている、画角外など判断できない場合は certainty と stepAssessment.status の両方を uncertain にしてください。",
    ]),
    isSalmon
      ? "工程の完了や安全性を保証してはいけません。利用者が魚と手元を確認できる状態にしてください。"
      : "工程の完了や安全性を保証せず、次の工程へ進めてもいけません。進行は利用者が操作します。",
    `魚種ID: ${options.fishId}`,
    `確認中の工程: ${options.step.title}`,
    `表示中の参考ガイドの説明: ${options.step.description}`,
    `この工程の目標となる魚体状態: ${options.step.expectedState}`,
    ...(isSalmon && baselineBase64
      ? ["fishStateAssessment.evidenceは魚体状態の根拠、stepAssessment.evidenceは開始時と現在の比較に基づく工程の根拠です。evidenceは見える部位全体の根拠、cautionは必要な場合の短い注意です。2つの判定を混同しないでください。"]
      : isSalmon
        ? ["fishStateAssessment.evidenceは魚体状態の根拠、stepAssessment.evidenceは現在画像に写る工程の根拠です。evidenceは見える部位全体の根拠、cautionは必要な場合の短い注意です。2つの判定を混同しないでください。"]
        : ["stepAssessment.evidenceは工程の見た目について、画像で確認できた短い根拠を書いてください。evidenceは見える部位の根拠、cautionは必要な場合の短い注意です。"]),
  ].join("\n");

  const model = options.model?.trim() || DEFAULT_MODEL;
  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: prompt },
          ...(baselineBase64 ? [{ inlineData: { mimeType: "image/jpeg", data: baselineBase64 } }] : []),
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
        ] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: createResponseSchema(isSalmon),
          temperature: 0.2,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new GeminiRequestError(504, "GEMINI_TIMEOUT", "Geminiへの接続がタイムアウトしました。少し待ってから再試行してください。");
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new GeminiRequestError(502, "GEMINI_AUTH_FAILED", "Gemini APIキーを確認できませんでした。.envのキー設定とGoogle AI Studioの利用権限を確認してください。");
    }
    if (response.status === 429) {
      throw new GeminiRequestError(429, "GEMINI_RATE_LIMITED", "Gemini APIの利用上限に達しました。時間をおいて再試行してください。");
    }
    throw new GeminiRequestError(502, "GEMINI_UPSTREAM_ERROR", "Gemini APIから応答を取得できませんでした。モデル名とAPIの状態を確認してください。");
  }

  let payload: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  try {
    payload = await response.json() as typeof payload;
    const text = payload.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
    if (!text) throw new Error("Empty Gemini response");
    const output = JSON.parse(text) as unknown;
    if (isSalmon) {
      const result = GuideSalmonImageAnalysisResultSchema.parse(output);
      return GuideSalmonImageAnalysisResponseSchema.parse({ ...result, model });
    }
    const result = GuideImageAnalysisResultSchema.parse(output);
    return GuideImageAnalysisResponseSchema.parse({ ...result, model });
  } catch {
    throw new GeminiRequestError(502, "GEMINI_INVALID_RESPONSE", "Geminiの回答形式を確認できませんでした。もう一度お試しください。");
  }
}
