import {
  CATALOG,
  FishIdSchema,
  FishStateSchema,
  ObservationSchema,
  getReferenceGuide,
} from "@orewosabake/contracts";
import { z } from "zod";

const GeminiFishAnalysisRequestSchema = z.object({
  fishId: FishIdSchema,
  currentStepId: z.string().min(1).max(100),
  imageBase64: z.string().min(1).max(700_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  mediaPipeObservation: ObservationSchema.nullable().optional(),
}).strict();
export const GeminiFishAnalysisResultSchema = z.object({ observedState: FishStateSchema }).strict();
type GeminiFishAnalysisRequest = z.infer<typeof GeminiFishAnalysisRequestSchema>;
type GeminiFishAnalysisResult = z.infer<typeof GeminiFishAnalysisResultSchema>;

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TIMEOUT_MS = 55_000;
const GEMINI_OVERALL_TIMEOUT_MS = 60_000;
const GEMINI_MAX_ATTEMPTS = 2;
const GEMINI_RETRY_BASE_DELAY_MS = 1_000;
const GEMINI_MAX_RETRY_DELAY_MS = 8_000;

const responseSchema = {
  type: "OBJECT",
  properties: {
    observedState: {
      type: "STRING",
      enum: ["whole_fish", "head_removed", "opened", "filleting", "filleted", "unknown"],
    },
  },
  required: ["observedState"],
  propertyOrdering: ["observedState"],
} as const;

const generateContentResponseSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({
      parts: z.array(z.object({ text: z.string().optional() }).passthrough()).optional(),
    }).passthrough().optional(),
    finishReason: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

const upstreamErrorSchema = z.object({
  error: z.object({
    code: z.union([z.number(), z.string()]).optional(),
    status: z.string().optional(),
  }).passthrough(),
}).passthrough();

export class GeminiFishAnalysisError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type GeminiFishAnalysisConfig = {
  apiKey?: string;
  model?: string;
  apiUrl?: string;
  testMode?: boolean;
  testScenario?: string;
  timeoutMs?: number;
  overallTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
};

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new GeminiFishAnalysisError(500, "GEMINI_CONFIG_INVALID", "Gemini APIのサーバー設定を確認してください。");
  }
  return value;
}

function getGeminiEndpoint(config: GeminiFishAnalysisConfig, model: string): string {
  if (!config.testMode) {
    return `${DEFAULT_GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`;
  }
  if (!config.apiUrl?.trim()) {
    throw new GeminiFishAnalysisError(503, "GEMINI_TEST_ENDPOINT_MISSING", "テスト用Gemini APIが設定されていません。");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(config.apiUrl);
  } catch {
    throw new GeminiFishAnalysisError(503, "GEMINI_TEST_ENDPOINT_INVALID", "テスト用Gemini APIのURLを確認してください。");
  }
  if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(endpoint.hostname)) {
    throw new GeminiFishAnalysisError(503, "GEMINI_TEST_ENDPOINT_INVALID", "テスト用Gemini APIはローカルホストに限られます。");
  }
  return endpoint.toString();
}

function normalizedError(value: number | string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function shouldRetry(
  status: number,
  errorCode: number | string | undefined,
  errorStatus: string | undefined,
): boolean {
  if ([408, 500, 502, 503, 504].includes(status)) return true;
  if (status !== 429) return false;
  const upstreamCode = normalizedError(errorCode);
  const upstreamStatus = normalizedError(errorStatus);
  return !["quota_exceeded", "payment_required"].includes(upstreamCode)
    && !["quota_exceeded", "payment_required"].includes(upstreamStatus);
}

function retryDelayMs(response: Response, attempt: number, baseDelayMs: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(GEMINI_MAX_RETRY_DELAY_MS, Math.round(seconds * 1_000));
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(GEMINI_MAX_RETRY_DELAY_MS, Math.max(0, retryAt - Date.now()));
    }
  }
  const ceiling = Math.min(GEMINI_MAX_RETRY_DELAY_MS, baseDelayMs * (2 ** (attempt - 1)));
  return Math.round(ceiling * (0.5 + Math.random()));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function throwForUpstreamError(status: number, code: number | string | undefined, upstreamStatus: string | undefined): never {
  const normalizedCode = normalizedError(code);
  const normalizedStatus = normalizedError(upstreamStatus);
  const explicitQuota = status === 402
    || ["quota_exceeded", "payment_required"].includes(normalizedCode)
    || ["quota_exceeded", "payment_required"].includes(normalizedStatus);
  if (explicitQuota) {
    throw new GeminiFishAnalysisError(429, "GEMINI_QUOTA_EXCEEDED", "Gemini APIの利用上限に達しました。利用枠を確認してください。");
  }
  if (status === 401 || status === 403) {
    throw new GeminiFishAnalysisError(503, "GEMINI_AUTH_FAILED", "Gemini APIキーまたはAPIの設定を確認してください。");
  }
  if (status === 429) {
    throw new GeminiFishAnalysisError(429, "GEMINI_RATE_LIMITED", "Gemini APIの呼出し制限に達しました。時間をおいて再試行してください。");
  }
  if (status === 503) {
    throw new GeminiFishAnalysisError(503, "GEMINI_TEMPORARILY_UNAVAILABLE", "Gemini APIが一時的に応答できません。少し待って再試行してください。");
  }
  if (status === 504) {
    throw new GeminiFishAnalysisError(504, "GEMINI_UPSTREAM_TIMEOUT", "Gemini APIの応答期限を超えました。時間をおいて再試行してください。");
  }
  throw new GeminiFishAnalysisError(502, "GEMINI_REQUEST_FAILED", "Geminiが画像を確認できませんでした。もう一度お試しください。");
}

export async function analyzeFishFrame(
  value: unknown,
  config: GeminiFishAnalysisConfig,
): Promise<GeminiFishAnalysisResult> {
  const parsed = GeminiFishAnalysisRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new GeminiFishAnalysisError(422, "GEMINI_INPUT_INVALID", "画像または魚の情報を確認してください。");
  }

  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new GeminiFishAnalysisError(503, "GEMINI_NOT_CONFIGURED", "GEMINI_API_KEYを環境変数または.envに設定してください。");
  }

  const request: GeminiFishAnalysisRequest = parsed.data;
  const fish = CATALOG.fish.find((item) => item.id === request.fishId);
  const guide = getReferenceGuide(request.fishId);
  const currentStep = guide?.steps.find((step) => step.id === request.currentStepId);
  if (!fish || !guide || !currentStep) {
    throw new GeminiFishAnalysisError(422, "GEMINI_GUIDE_CONTEXT_INVALID", "現在の魚または工程を確認できません。");
  }

  const prompt = [
    "あなたは魚のさばき作業を画面越しに補助する観察アシスタントです。",
    "画像で確認できる魚の状態だけを、指定された有限の状態から1つ選んでください。",
    "状態の意味: whole_fish=頭と尾が付いた魚体が見える、head_removed=頭が外れたことが明瞭、opened=腹が開いている、filleting=身を中骨から外している途中、filleted=身と中骨が分かれている、unknown=魚や作業が見えない・隠れている・区別できない。",
    "カメラ外、手や道具による隠れ、ぼけ、暗さ、角度によって判断できない場合はunknownにしてください。",
    "MediaPipeの頭・尾の検出枠は補助情報です。検出されないことだけを理由に、頭や尾が外れたと判断してはいけません。",
    "現在の工程名や期待状態から画像の状態を決めつけず、画像を根拠にしてください。",
    "工程の完了、安全性、鮮度、食用可否、寄生虫の有無を断定しないでください。包丁の指示や新しい手順を作らないでください。",
    "指定されたJSONスキーマに合うJSONだけを返してください。",
    "",
    "確認用コンテキスト:",
    JSON.stringify({
      fishName: fish.name,
      currentStep: {
        title: currentStep.title,
        expectedState: currentStep.expectedState,
      },
      mediaPipeObservation: request.mediaPipeObservation,
    }),
  ].join("\n");

  const model = config.model?.trim() || DEFAULT_GEMINI_MODEL;
  const timeoutMs = positiveInteger(config.timeoutMs, GEMINI_TIMEOUT_MS, GEMINI_TIMEOUT_MS);
  const overallTimeoutMs = positiveInteger(config.overallTimeoutMs, GEMINI_OVERALL_TIMEOUT_MS, GEMINI_OVERALL_TIMEOUT_MS);
  const maxAttempts = positiveInteger(config.maxAttempts, GEMINI_MAX_ATTEMPTS, 3);
  const retryBaseDelayMs = positiveInteger(config.retryBaseDelayMs, GEMINI_RETRY_BASE_DELAY_MS, 2_000);
  const deadlineAt = Date.now() + overallTimeoutMs;

  function timeoutError(): GeminiFishAnalysisError {
    return new GeminiFishAnalysisError(504, "GEMINI_TIMEOUT", "Geminiの確認に時間がかかっています。少し待って再試行してください。");
  }

  function ensureRetryFits(delayMs: number): void {
    if (Date.now() + delayMs + 100 >= deadlineAt) throw timeoutError();
  }

  async function requestModel(selectedModel: string): Promise<Response> {
    const endpoint = getGeminiEndpoint(config, selectedModel);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const requestStartedAt = Date.now();
      const remainingMs = deadlineAt - requestStartedAt;
      if (remainingMs <= 0) throw timeoutError();
      const attemptTimeoutMs = Math.min(timeoutMs, remainingMs);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
            ...(config.testMode && config.testScenario ? { "x-k6-scenario": config.testScenario } : {}),
          },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { text: prompt },
                { inlineData: { mimeType: "image/jpeg", data: request.imageBase64 } },
              ],
            }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema,
            },
          }),
          signal: AbortSignal.timeout(attemptTimeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        if (timedOut) {
          console.error("Gemini generateContent request timed out", { attempt, timeoutMs: attemptTimeoutMs, model: selectedModel });
          if (attempt < maxAttempts) {
            const ceiling = Math.min(GEMINI_MAX_RETRY_DELAY_MS, retryBaseDelayMs * (2 ** (attempt - 1)));
            const delayMs = Math.round(ceiling * (0.5 + Math.random()));
            ensureRetryFits(delayMs);
            console.warn("Gemini generateContent timeout; retrying within the overall deadline", {
              attempt,
              delayMs,
              elapsedMs: Date.now() - requestStartedAt,
              model: selectedModel,
            });
            await wait(delayMs);
            continue;
          }
          throw timeoutError();
        }
        if (attempt < maxAttempts) {
          const ceiling = Math.min(GEMINI_MAX_RETRY_DELAY_MS, retryBaseDelayMs * (2 ** (attempt - 1)));
          const delayMs = Math.round(ceiling * (0.5 + Math.random()));
          ensureRetryFits(delayMs);
          console.warn("Gemini generateContent network error; retrying", {
            attempt,
            delayMs,
            elapsedMs: Date.now() - requestStartedAt,
            model: selectedModel,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          await wait(delayMs);
          continue;
        }
        console.error("Gemini generateContent request failed", {
          attempt,
          elapsedMs: Date.now() - requestStartedAt,
          model: selectedModel,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        throw new GeminiFishAnalysisError(502, "GEMINI_UNAVAILABLE", "Geminiに接続できませんでした。時間をおいて再試行してください。");
      }

      if (response.ok) return response;

      const errorPayload = await response.clone().json().catch(() => null);
      const upstreamError = upstreamErrorSchema.safeParse(errorPayload);
      const errorCode = upstreamError.success ? upstreamError.data.error.code : undefined;
      const errorStatus = upstreamError.success ? upstreamError.data.error.status : undefined;
      if (shouldRetry(response.status, errorCode, errorStatus) && attempt < maxAttempts) {
        const delayMs = retryDelayMs(response, attempt, retryBaseDelayMs);
        ensureRetryFits(delayMs);
        console.warn("Gemini generateContent API transient error; retrying", {
          attempt,
          delayMs,
          elapsedMs: Date.now() - requestStartedAt,
          model: selectedModel,
          httpStatus: response.status,
          ...(errorCode === undefined ? {} : { code: errorCode }),
          ...(errorStatus ? { status: errorStatus } : {}),
        });
        await wait(delayMs);
        continue;
      }

      console.error("Gemini generateContent API returned non-success", {
        attempt,
        elapsedMs: Date.now() - requestStartedAt,
        model: selectedModel,
        httpStatus: response.status,
        ...(errorCode === undefined ? {} : { code: errorCode }),
        ...(errorStatus ? { status: errorStatus } : {}),
      });
      return response;
    }
    throw new GeminiFishAnalysisError(502, "GEMINI_UNAVAILABLE", "Geminiの応答を確認できませんでした。");
  }

  const response = await requestModel(model);
  if (!response.ok) {
    const errorPayload = await response.clone().json().catch(() => null);
    const upstreamError = upstreamErrorSchema.safeParse(errorPayload);
    const errorCode = upstreamError.success ? upstreamError.data.error.code : undefined;
    const errorStatus = upstreamError.success ? upstreamError.data.error.status : undefined;
    throwForUpstreamError(response.status, errorCode, errorStatus);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GeminiFishAnalysisError(502, "GEMINI_INVALID_RESPONSE", "Geminiから応答を読み取れませんでした。");
  }

  const generated = generateContentResponseSchema.safeParse(payload);
  if (!generated.success) {
    throw new GeminiFishAnalysisError(502, "GEMINI_INVALID_RESPONSE", "Geminiから応答を読み取れませんでした。");
  }

  const outputText = generated.data.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .find((part) => typeof part.text === "string")?.text;
  if (!outputText) {
    throw new GeminiFishAnalysisError(502, "GEMINI_EMPTY_RESPONSE", "Geminiから確認結果を受け取れませんでした。");
  }

  let output: unknown;
  try {
    output = JSON.parse(outputText) as unknown;
  } catch {
    throw new GeminiFishAnalysisError(502, "GEMINI_INVALID_JSON", "Geminiの応答を結果として読み取れませんでした。");
  }
  const result = GeminiFishAnalysisResultSchema.safeParse(output);
  if (!result.success) {
    throw new GeminiFishAnalysisError(502, "GEMINI_SCHEMA_MISMATCH", "Geminiの応答が確認結果の形式に合いませんでした。");
  }
  return result.data;
}

