import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdvanceGuideStepRequestSchema,
  CATALOG,
  GuideImageAnalysisRequestSchema,
  GuideContextRequestSchema,
  GuideRequestSchema,
  GuideSessionSchema,
  FishIdSchema,
  getReferenceGuide,
  resolveGuideFishId,
  MOCK_MODEL_STATUS,
  MOCK_OBSERVATION,
  ORIENTATION_CONFIG,
  type GuideSession,
} from "@orewosabake/contracts";
import { analyzeGuideImage, GeminiRequestError } from "./gemini.js";

const projectEnvPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(projectEnvPath)) process.loadEnvFile(projectEnvPath);

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_ANALYSIS_BODY_BYTES = 5_900_000;
const MAX_ANALYSIS_IMAGE_BYTES = 2_000_000;
const MAX_GUIDE_SESSIONS = 500;
const GUIDE_SESSION_TTL_MS = 30 * 60 * 1000;
const guideSessions = new Map<string, GuideSession>();

function pruneExpiredGuideSessions(now = Date.now()) {
  for (const [sessionId, session] of guideSessions) {
    if (now - Date.parse(session.updatedAt) >= GUIDE_SESSION_TTL_MS) {
      guideSessions.delete(sessionId);
    }
  }
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendError(
  response: import("node:http").ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  sendJson(response, status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
}

async function readJsonBody(request: import("node:http").IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw Object.assign(new Error("Content-Typeにapplication/jsonを指定してください。"), { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" });
  }

  const declaredLength = Number(request.headers["content-length"] ?? 0);
  let tooLarge = Number.isFinite(declaredLength) && declaredLength > maxBytes;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (tooLarge) continue;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) {
    throw Object.assign(new Error(`リクエストのサイズが上限（${Math.round(maxBytes / 1024)} KiB）を超えています。`), { status: 413, code: "PAYLOAD_TOO_LARGE" });
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw Object.assign(new Error("リクエスト本文が正しいJSON形式ではありません。"), { status: 400, code: "INVALID_JSON" });
  }
}

function createReferenceSession(fishId: GuideSession["fishId"], preparationId: GuideSession["preparationId"], guide: NonNullable<ReturnType<typeof getReferenceGuide>>): GuideSession {
  const now = new Date().toISOString();
  return GuideSessionSchema.parse({
    sessionId: randomUUID(),
    fishId,
    preparationId,
    guide,
    currentStep: guide.steps[0],
    currentStepIndex: 0,
    completedStepIds: [],
    status: "active",
    source: "public_reference",
    createdAt: now,
    updatedAt: now,
  });
}

function validationDetails(issues: Array<{ code: string; path: PropertyKey[] }>) {
  return issues.map((issue) => {
    const field = issue.path[0];
    const message = issue.code === "unrecognized_keys"
      ? "未対応の項目が含まれています。"
      : field === "fishId"
        ? "魚種はカタログにある候補から選んでください。"
        : field === "preparationId"
          ? "目的は「可食部を骨から外す」を指定してください。"
          : field === "fishName"
            ? "魚の名前を入力してください。"
            : field === "fishCategory"
              ? "魚のカテゴリを指定してください。"
              : field === "fishState"
                ? "魚の状態を指定してください。"
          : field === "stepId"
            ? "現在の工程IDを指定してください。"
            : field === "source"
              ? "進行方法はbuttonまたはvoiceを指定してください。"
              : "入力内容を確認してください。";
    return { field: issue.path.join("."), message };
  });
}

async function handleRequest(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
  let pathname: string;
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url ?? "/", "http://localhost");
    pathname = requestUrl.pathname;
  } catch {
    sendError(response, 400, "BAD_REQUEST", "リクエストURLの形式が正しくありません。");
    return;
  }

  pruneExpiredGuideSessions();

  if (pathname === "/api/guide/analyze" && request.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(request, MAX_ANALYSIS_BODY_BYTES);
    } catch (error) {
      const failure = error as Error & { status?: number; code?: string };
      sendError(response, failure.status ?? 400, failure.code ?? "BAD_REQUEST", failure.message);
      return;
    }
    const parsed = GuideImageAnalysisRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(response, 422, "VALIDATION_ERROR", "魚種、工程、JPEG画像を確認してください。");
      return;
    }
    const guide = getReferenceGuide(parsed.data.fishId, "edible_portion");
    const step = guide?.steps.find((candidate) => candidate.id === parsed.data.stepId);
    if (!guide || !step) {
      sendError(response, 422, "GUIDE_STEP_NOT_FOUND", "選択中の魚種と工程を確認してください。");
      return;
    }
    const imageBytes = Buffer.from(parsed.data.imageData.slice(parsed.data.imageData.indexOf(",") + 1), "base64");
    const baselineImageBytes = parsed.data.baselineImageData
      ? Buffer.from(parsed.data.baselineImageData.slice(parsed.data.baselineImageData.indexOf(",") + 1), "base64")
      : null;
    if (imageBytes.byteLength > MAX_ANALYSIS_IMAGE_BYTES || (baselineImageBytes?.byteLength ?? 0) > MAX_ANALYSIS_IMAGE_BYTES) {
      sendError(response, 413, "IMAGE_TOO_LARGE", "画像サイズは2 MiB以下にしてください。");
      return;
    }
    if (imageBytes.byteLength + (baselineImageBytes?.byteLength ?? 0) > MAX_ANALYSIS_IMAGE_BYTES * 2) {
      sendError(response, 413, "IMAGES_TOO_LARGE", "画像の合計サイズは4 MiB以下にしてください。");
      return;
    }
    try {
      const result = await analyzeGuideImage({
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL,
        fishId: parsed.data.fishId,
        step,
        ...(parsed.data.baselineImageData ? { baselineImageData: parsed.data.baselineImageData } : {}),
        imageData: parsed.data.imageData,
      });
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof GeminiRequestError) {
        sendError(response, error.status, error.code, error.message);
        return;
      }
      sendError(response, 502, "GEMINI_UPSTREAM_ERROR", "Gemini APIから応答を取得できませんでした。");
    }
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})$/i);
  const advanceMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})\/advance$/i);

  if (pathname === "/api/guide/sessions" && request.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const failure = error as Error & { status?: number; code?: string };
      sendError(response, failure.status ?? 400, failure.code ?? "BAD_REQUEST", failure.message);
      return;
    }
    const parsed = GuideRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(response, 422, "VALIDATION_ERROR", "入力内容に誤りがあります。", validationDetails(parsed.error.issues));
      return;
    }
    const guide = getReferenceGuide(parsed.data.fishId, parsed.data.preparationId);
    if (!guide) {
      sendError(response, 404, "GUIDE_NOT_AVAILABLE", "この魚の参考手順はまだ登録されていません。");
      return;
    }
    if (guideSessions.size >= MAX_GUIDE_SESSIONS) {
      sendError(response, 503, "SESSION_CAPACITY_REACHED", "保持中のガイドセッション数が上限に達しています。時間をおいて再試行してください。");
      return;
    }
    const session = createReferenceSession(parsed.data.fishId, parsed.data.preparationId, guide);
    guideSessions.set(session.sessionId, session);
    sendJson(response, 201, session);
    return;
  }

  if (sessionMatch && request.method === "GET") {
    const session = guideSessions.get(sessionMatch[1]!);
    if (!session) {
      sendError(response, 404, "SESSION_NOT_FOUND", "ガイドセッションが見つかりません。");
      return;
    }
    sendJson(response, 200, session);
    return;
  }

  if (advanceMatch && request.method === "POST") {
    const session = guideSessions.get(advanceMatch[1]!);
    if (!session) {
      sendError(response, 404, "SESSION_NOT_FOUND", "ガイドセッションが見つかりません。");
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const failure = error as Error & { status?: number; code?: string };
      sendError(response, failure.status ?? 400, failure.code ?? "BAD_REQUEST", failure.message);
      return;
    }
    const parsed = AdvanceGuideStepRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(response, 422, "VALIDATION_ERROR", "入力内容に誤りがあります。", validationDetails(parsed.error.issues));
      return;
    }
    if (parsed.data.source === "voice" && parsed.data.transcript?.trim() !== "次へ") {
      sendError(response, 422, "VOICE_COMMAND_NOT_RECOGNIZED", "音声入力で「次へ」と確認できませんでした。工程は進めていません。", { session });
      return;
    }
    if (session.status === "completed") {
      sendError(response, 409, "SESSION_COMPLETED", "このガイドはすでに完了しています。", { session });
      return;
    }
    if (parsed.data.stepId !== session.currentStep?.id) {
      sendError(response, 409, "STEP_CONFLICT", "工程が更新されています。現在の工程を確認してください。", { session });
      return;
    }

    const completedStepIds = [...session.completedStepIds, parsed.data.stepId];
    const nextStepIndex = session.currentStepIndex + 1;
    const nextSession = GuideSessionSchema.parse({
      ...session,
      currentStep: session.guide.steps[nextStepIndex] ?? null,
      currentStepIndex: nextStepIndex,
      completedStepIds,
      status: nextStepIndex >= session.guide.steps.length ? "completed" : "active",
      updatedAt: new Date().toISOString(),
    });
    guideSessions.set(session.sessionId, nextSession);
    sendJson(response, 200, nextSession);
    return;
  }

  if (pathname === "/api/guide" && request.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const failure = error as Error & { status?: number; code?: string };
      sendError(response, failure.status ?? 400, failure.code ?? "BAD_REQUEST", failure.message);
      return;
    }

    const contextRequest = GuideContextRequestSchema.safeParse(body);
    const guideRequest = GuideRequestSchema.safeParse(body);
    if (!contextRequest.success && !guideRequest.success) {
      const looksLikeContextRequest = typeof body === "object"
        && body !== null
        && ["fishName", "fishCategory", "fishState"].some((field) => field in body);
      const issues = looksLikeContextRequest ? contextRequest.error.issues : guideRequest.error.issues;
      sendError(response, 422, "VALIDATION_ERROR", "入力内容に誤りがあります。", validationDetails(issues));
      return;
    }

    const fishId = contextRequest.success
      ? resolveGuideFishId(contextRequest.data.fishName) ?? "other_finfish"
      : guideRequest.success ? guideRequest.data.fishId : undefined;
    const guide = fishId
      ? getReferenceGuide(fishId, guideRequest.success ? guideRequest.data.preparationId : undefined)
      : undefined;
    if (!guide) {
      sendError(response, 404, "GUIDE_NOT_AVAILABLE", "この魚の参考手順はまだ登録されていません。");
      return;
    }
    sendJson(response, 200, guide);
    return;
  }

  const postOnlySessionPath = pathname === "/api/guide/sessions" || pathname === "/api/guide/analyze" || advanceMatch !== null;
  if (postOnlySessionPath && request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendError(response, 405, "METHOD_NOT_ALLOWED", "このHTTPメソッドには対応していません。");
    return;
  }

  if (request.method !== "GET") {
    const sessionEndpoint = pathname === "/api/guide/sessions" || sessionMatch !== null || advanceMatch !== null;
    const supportedPath = [
      "/api/health",
      "/api/guide",
      "/api/guide/analyze",
      "/api/model/status",
      "/api/config/orientation",
      "/api/catalog",
      "/api/model/mock-observation",
    ].includes(pathname) || sessionEndpoint;
    if (!supportedPath) {
      sendError(response, 404, "NOT_FOUND", "指定されたAPIは見つかりません。");
      return;
    }
    const allow = pathname === "/api/guide"
      ? "GET, POST"
      : pathname === "/api/guide/analyze"
        ? "POST"
      : pathname === "/api/guide/sessions" || advanceMatch
        ? "POST"
        : "GET";
    response.setHeader("Allow", allow);
    sendError(response, 405, "METHOD_NOT_ALLOWED", "このHTTPメソッドには対応していません。");
    return;
  }

  switch (pathname) {
    case "/api/health":
      sendJson(response, 200, { status: "ok", service: "orewosabake-api" });
      return;
    case "/api/guide": {
      const fishId = FishIdSchema.safeParse(requestUrl.searchParams.get("fishId"));
      if (!fishId.success) {
        sendError(response, 400, "FISH_REQUIRED", "fishIdで魚種を指定してください。");
        return;
      }
      const guide = getReferenceGuide(fishId.data);
      if (!guide) {
        sendError(response, 404, "GUIDE_NOT_AVAILABLE", "この魚の参考手順はまだ登録されていません。");
        return;
      }
      sendJson(response, 200, guide);
      return;
    }
    case "/api/catalog":
      sendJson(response, 200, CATALOG);
      return;
    case "/api/model/status":
      sendJson(response, 200, MOCK_MODEL_STATUS);
      return;
    case "/api/config/orientation":
      sendJson(response, 200, ORIENTATION_CONFIG);
      return;
    case "/api/model/mock-observation":
      sendJson(response, 200, MOCK_OBSERVATION);
      return;
    default:
      sendError(response, 404, "NOT_FOUND", "指定されたAPIは見つかりません。");
  }
}

const server = createServer((request, response) => void handleRequest(request, response));

server.listen(port, host, () => {
  console.log(`orewosabake API listening at http://${host}:${port}`);
});
