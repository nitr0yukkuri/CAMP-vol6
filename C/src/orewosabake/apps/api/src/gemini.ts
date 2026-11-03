import {
  GuideImageAnalysisResponseSchema,
  GuideImageAnalysisResultSchema,
  type GuideStep,
  type FishId,
  type GuideImageAnalysisResponse,
} from "@orewosabake/contracts";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const responseSchema = {
  type: "OBJECT",
  properties: {
    certainty: { type: "STRING", enum: ["observed", "uncertain"] },
    visibleParts: { type: "ARRAY", items: { type: "STRING", enum: ["head", "body", "tail"] } },
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
  },
  required: ["certainty", "visibleParts", "stepAssessment", "evidence", "caution"],
  propertyOrdering: ["certainty", "visibleParts", "stepAssessment", "evidence", "caution"],
} as const;

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
  imageData: string;
}): Promise<GuideImageAnalysisResponse> {
  if (!options.apiKey) {
    throw new GeminiRequestError(503, "GEMINI_NOT_CONFIGURED", "Gemini APIキーが設定されていません。.envのGEMINI_API_KEYを確認してください。");
  }

  const [header, imageBase64] = options.imageData.split(",", 2);
  if (header !== "data:image/jpeg;base64" || !imageBase64) {
    throw new GeminiRequestError(422, "INVALID_IMAGE", "JPEG画像を送信してください。");
  }

  const prompt = [
    "あなたは魚の調理工程を補助する画像確認役です。回答は日本語で、指定されたJSON形式だけにしてください。",
    "画像から直接見える事実だけを短く述べてください。魚種、鮮度、食用安全性、骨の完全な除去を保証してはいけません。",
    "visiblePartsでは画像内にはっきり見える頭・体・尾だけを返してください。",
    "stepAssessment.status は、この画像の見た目が現在の工程をどこまで示しているかを慎重に推定してください。",
    "likely_complete は工程完了を示す明確な見た目の証拠がある場合だけ、in_progress は明確に未完了と分かる場合だけにしてください。それ以外は uncertain にしてください。",
    "うろこ取りや小骨確認など、画像だけで作業結果を確かめられない工程は uncertain にしてください。期待状態のラベルだけから完了を推測してはいけません。",
    "工程の完了や安全性を保証せず、次の工程へ進めてもいけません。進行は利用者が操作します。",
    "不鮮明、隠れている、画角外など判断できない場合は certainty と stepAssessment.status の両方を uncertain にしてください。",
    `魚種ID: ${options.fishId}`,
    `確認中の工程: ${options.step.title}`,
    `表示中の参考ガイドの説明: ${options.step.description}`,
    `この工程の目安状態: ${options.step.expectedState}`,
    "stepAssessment.evidence は工程の見た目について、画像で確認できた短い根拠を書いてください。evidence は見える部位の根拠、caution は必要な場合の短い注意です。",
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
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
        ] }],
        generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0.2 },
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
    const result = GuideImageAnalysisResultSchema.parse(JSON.parse(text) as unknown);
    return GuideImageAnalysisResponseSchema.parse({ ...result, model });
  } catch {
    throw new GeminiRequestError(502, "GEMINI_INVALID_RESPONSE", "Geminiの回答形式を確認できませんでした。もう一度お試しください。");
  }
}
