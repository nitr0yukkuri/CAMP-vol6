import {
  GuideImageAnalysisResponseSchema,
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
    evidence: { type: "STRING" },
    caution: { type: "STRING" },
  },
  required: ["certainty", "visibleParts", "evidence", "caution"],
  propertyOrdering: ["certainty", "visibleParts", "evidence", "caution"],
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
    "現在の工程が完了したか、次の工程へ進めるかを決めてはいけません。利用者の明示操作なしに工程を進めてはいけません。",
    "不鮮明、隠れている、画角外など判断できない場合は certainty を uncertain にし、推測しないでください。",
    `魚種ID: ${options.fishId}`,
    `確認中の工程: ${options.step.title}`,
    `確認済みガイドの説明: ${options.step.description}`,
    "visibleParts は画像内にはっきり見える head/body/tail だけを含めてください。evidence は画像上で見えることと工程説明との関係、caution は必要な場合の短い注意です。",
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
    const result = GuideImageAnalysisResponseSchema.omit({ model: true }).parse(JSON.parse(text) as unknown);
    return GuideImageAnalysisResponseSchema.parse({ ...result, model });
  } catch {
    throw new GeminiRequestError(502, "GEMINI_INVALID_RESPONSE", "Geminiの回答形式を確認できませんでした。もう一度お試しください。");
  }
}
