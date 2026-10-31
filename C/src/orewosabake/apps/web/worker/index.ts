import {
  AdvanceGuideStepRequestSchema,
  CATALOG,
  GuideContextRequestSchema,
  GuideRequestSchema,
  GuideSessionSchema,
  MOCK_GUIDE,
  MOCK_MODEL_STATUS,
  MOCK_OBSERVATION,
  ORIENTATION_CONFIG,
  type GuideSession,
} from "@orewosabake/contracts";

const maxBodyBytes = 16 * 1024;
const maxGuideSessions = 500;
const guideSessionTtlMs = 30 * 60 * 1000;
const guideSessions = new Map<string, GuideSession>();

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
    const { pathname } = new URL(request.url);
    pruneExpiredGuideSessions();

    const sessionMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})$/i);
    const advanceMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})\/advance$/i);

    if (pathname === "/api/guide/sessions" && request.method === "POST") {
      const body = await readRequestBody(request);
      const parsed = GuideRequestSchema.safeParse(body);
      if (!parsed.success) return validationError();
      if (guideSessions.size >= maxGuideSessions) {
        return errorResponse(503, "SESSION_CAPACITY_REACHED", "保持中のガイドセッション数が上限に達しています。時間をおいて再試行してください。");
      }
      const session = createMockSession(parsed.data.fishId, parsed.data.preparationId);
      guideSessions.set(session.sessionId, session);
      return json(session, 201);
    }

    if (sessionMatch && request.method === "GET") {
      const session = guideSessions.get(sessionMatch[1]!);
      return session
        ? json(session)
        : errorResponse(404, "SESSION_NOT_FOUND", "ガイドセッションが見つかりません。");
    }

    if (advanceMatch && request.method === "POST") {
      const sessionId = advanceMatch[1]!;
      const session = guideSessions.get(sessionId);
      if (!session) return errorResponse(404, "SESSION_NOT_FOUND", "ガイドセッションが見つかりません。");

      const body = await readRequestBody(request);
      const parsed = AdvanceGuideStepRequestSchema.safeParse(body);
      if (!parsed.success) return validationError();
      if (parsed.data.source === "voice" && parsed.data.transcript?.trim() !== "次へ") {
        return errorResponse(422, "VOICE_COMMAND_NOT_RECOGNIZED", "音声入力で「次へ」と確認できませんでした。工程は進めていません。", { session });
      }
      if (session.status === "completed") {
        return errorResponse(409, "SESSION_COMPLETED", "このガイドはすでに完了しています。", { session });
      }
      if (parsed.data.stepId !== session.currentStep?.id) {
        return errorResponse(409, "STEP_CONFLICT", "工程が更新されています。現在の工程を確認してください。", { session });
      }

      const completedStepIds = [...session.completedStepIds, parsed.data.stepId];
      const nextStepIndex = session.currentStepIndex + 1;
      const nextSession = GuideSessionSchema.parse({
        ...session,
        currentStep: MOCK_GUIDE.steps[nextStepIndex] ?? null,
        currentStepIndex: nextStepIndex,
        completedStepIds,
        status: nextStepIndex >= MOCK_GUIDE.steps.length ? "completed" : "active",
        updatedAt: new Date().toISOString(),
      });
      guideSessions.set(sessionId, nextSession);
      return json(nextSession);
    }

    if (pathname === "/api/guide" && request.method === "POST") {
      const body = await readRequestBody(request);
      const contextRequest = GuideContextRequestSchema.safeParse(body);
      const catalogRequest = GuideRequestSchema.safeParse(body);
      if (!contextRequest.success && !catalogRequest.success) return validationError();
      return errorResponse(503, "GUIDE_NOT_CONFIGURED", "対応する手順がまだ登録されていません。");
    }

    if (request.method === "GET") {
      switch (pathname) {
        case "/api/health":
          return json({ status: "ok", service: "orewosabake-api" });
        case "/api/catalog":
          return json(CATALOG);
        case "/api/guide":
          return json(MOCK_GUIDE);
        case "/api/model/status":
          return json(MOCK_MODEL_STATUS);
        case "/api/config/orientation":
          return json(ORIENTATION_CONFIG);
        case "/api/model/mock-observation":
          return json(MOCK_OBSERVATION);
      }
    }

    if (pathname.startsWith("/api/")) {
      const knownPath = pathname === "/api/health"
        || pathname === "/api/catalog"
        || pathname === "/api/guide"
        || pathname === "/api/model/status"
        || pathname === "/api/config/orientation"
        || pathname === "/api/model/mock-observation"
        || pathname === "/api/guide/sessions"
        || sessionMatch !== null
        || advanceMatch !== null;
      if (!knownPath) return errorResponse(404, "NOT_FOUND", "指定されたAPIは見つかりません。");

      const allow = pathname === "/api/guide"
        ? "GET, POST"
        : pathname === "/api/guide/sessions" || advanceMatch
          ? "POST"
          : sessionMatch
            ? "GET"
            : "GET";
      return new Response(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "このHTTPメソッドには対応していません。" } }), {
        status: 405,
        headers: { "Allow": allow, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    return new Response(null, { status: 404 });
    } catch (error) {
      if (error instanceof RequestError) return errorResponse(error.status, error.code, error.message);
      throw error;
    }
  },
} satisfies ExportedHandler;

function createMockSession(fishId: GuideSession["fishId"], preparationId: GuideSession["preparationId"]): GuideSession {
  const now = new Date().toISOString();
  return GuideSessionSchema.parse({
    sessionId: crypto.randomUUID(),
    fishId,
    preparationId,
    guide: MOCK_GUIDE,
    currentStep: MOCK_GUIDE.steps[0],
    currentStepIndex: 0,
    completedStepIds: [],
    status: "active",
    source: "mock",
    createdAt: now,
    updatedAt: now,
  });
}

function pruneExpiredGuideSessions(now = Date.now()) {
  for (const [sessionId, session] of guideSessions) {
    if (now - Date.parse(session.updatedAt) >= guideSessionTtlMs) guideSessions.delete(sessionId);
  }
}

async function readRequestBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new RequestError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Typeにapplication/jsonを指定してください。");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new RequestError(413, "PAYLOAD_TOO_LARGE", "リクエストのサイズが上限（16 KiB）を超えています。");
  }

  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "INVALID_JSON", "リクエスト本文が正しいJSON形式ではありません。");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBodyBytes) {
      await reader.cancel();
      throw new RequestError(413, "PAYLOAD_TOO_LARGE", "リクエストのサイズが上限（16 KiB）を超えています。");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new RequestError(400, "INVALID_JSON", "リクエスト本文が正しいJSON形式ではありません。");
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(status: number, code: string, message: string, details?: unknown): Response {
  return json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

function validationError(): Response {
  return errorResponse(422, "VALIDATION_ERROR", "入力内容に誤りがあります。");
}
