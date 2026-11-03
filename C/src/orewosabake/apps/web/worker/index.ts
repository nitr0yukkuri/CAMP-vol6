import { DurableObject } from "cloudflare:workers";
import {
  AdvanceGuideStepRequestSchema,
  CATALOG,
  GuideContextRequestSchema,
  GuideImageAnalysisRequestSchema,
  GuideImageAnalysisResponseSchema,
  GuideImageAnalysisResultSchema,
  GuideRequestSchema,
  GuideSessionSchema,
  getReferenceGuide,
  resolveGuideFishId,
  FishIdSchema,
  MOCK_MODEL_STATUS,
  MOCK_OBSERVATION,
  ORIENTATION_CONFIG,
  type GuideSession,
} from "@orewosabake/contracts";
import type { GuideImageAnalysisResponse } from "@orewosabake/contracts";

const maxBodyBytes = 16 * 1024;
const maxAnalysisBodyBytes = 2_950_000;
const maxAnalysisImageBytes = 2_000_000;
const analysisRateLimitCount = 10;
const analysisRateLimitWindowMs = 60_000;
const maxGuideSessions = 500;
const guideSessionTtlMs = 30 * 60 * 1000;
const sessionCreationBucketCapacity = 10;
const sessionCreationRefillMs = 10 * 1000;
const sessionCreationLimitRetentionMs = sessionCreationBucketCapacity * sessionCreationRefillMs;

interface Env {
  GUIDE_SESSIONS: DurableObjectNamespace<GuideSessionStore>;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_DAILY_ANALYSIS_LIMIT?: string;
  GEMINI_TEST_MODE?: string;
  GEMINI_TEST_API_URL?: string;
  GEMINI_TEST_TIMEOUT_MS?: string;
  GEMINI_TEST_OVERALL_TIMEOUT_MS?: string;
  GEMINI_TEST_MAX_ATTEMPTS?: string;
  GEMINI_TEST_RETRY_BASE_DELAY_MS?: string;
  GEMINI_TEST_ANALYSIS_LIMIT?: string;
  GEMINI_TEST_DAILY_ANALYSIS_LIMIT?: string;
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
    const url = new URL(request.url);
    const { pathname } = url;

    const sessionMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})$/i);
    const advanceMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})\/advance$/i);

    if (pathname === "/api/guide/analyze" && request.method === "POST") {
      const body = await readRequestBody(request, maxAnalysisBodyBytes);
      const parsed = GuideImageAnalysisRequestSchema.safeParse(body);
      if (!parsed.success) return errorResponse(422, "VALIDATION_ERROR", "魚種、工程、JPEG画像を確認してください。");
      const guide = getReferenceGuide(parsed.data.fishId, "edible_portion");
      const step = guide?.steps.find((candidate) => candidate.id === parsed.data.stepId);
      if (!guide || !step) return errorResponse(422, "GUIDE_STEP_NOT_FOUND", "選択中の魚種と工程を確認してください。");
      const base64 = parsed.data.imageData.slice(parsed.data.imageData.indexOf(",") + 1);
      let decodedImageLength = 0;
      try {
        decodedImageLength = atob(base64).length;
      } catch {
        return errorResponse(422, "INVALID_IMAGE", "JPEG画像を送信してください。");
      }
      if (decodedImageLength > maxAnalysisImageBytes) return errorResponse(413, "IMAGE_TOO_LARGE", "画像サイズは2 MiB以下にしてください。");
      const clientHash = await hashClientAddress(request.headers.get("cf-connecting-ip") ?? "local-development");
      const limitResponse = await env.GUIDE_SESSIONS.getByName("guide-sessions").fetch(new Request("https://guide-session.internal/internal/gemini-analysis-limit", {
        method: "POST",
        headers: { "x-client-hash": clientHash },
      }));
      if (!limitResponse.ok) return limitResponse;
      try {
        const testScenario = env.GEMINI_TEST_MODE === "true" ? request.headers.get("x-k6-scenario") : null;
        return json(await analyzeWithGemini(env, parsed.data.fishId, step.title, step.description, step.expectedState, base64, testScenario));
      } catch (error) {
        if (error instanceof RequestError) return errorResponse(error.status, error.code, error.message);
        return errorResponse(502, "GEMINI_UPSTREAM_ERROR", "Gemini APIから応答を取得できませんでした。");
      }
    }

    if (pathname === "/api/guide/sessions" || sessionMatch || advanceMatch) {
      const durableRequest = new Request(new URL(pathname, "https://guide-session.internal"), request);
      return env.GUIDE_SESSIONS.getByName("guide-sessions").fetch(durableRequest);
    }

    if (pathname === "/api/guide" && request.method === "POST") {
      const body = await readRequestBody(request);
      const contextRequest = GuideContextRequestSchema.safeParse(body);
      const catalogRequest = GuideRequestSchema.safeParse(body);
      if (!contextRequest.success && !catalogRequest.success) return validationError();
      const fishId = contextRequest.success
        ? resolveGuideFishId(contextRequest.data.fishName) ?? "other_finfish"
        : catalogRequest.success ? catalogRequest.data.fishId : undefined;
      const guide = fishId
        ? getReferenceGuide(fishId, catalogRequest.success ? catalogRequest.data.preparationId : undefined)
        : undefined;
      return guide
        ? json(guide)
        : errorResponse(404, "GUIDE_NOT_AVAILABLE", "この魚の参考手順はまだ登録されていません。");
    }

    if (request.method === "GET") {
      switch (pathname) {
        case "/api/health":
          return json({ status: "ok", service: "orewosabake-api" });
        case "/api/catalog":
          return json(CATALOG);
        case "/api/guide": {
          const fishId = FishIdSchema.safeParse(url.searchParams.get("fishId"));
          if (!fishId.success) return errorResponse(400, "FISH_REQUIRED", "fishIdで魚種を指定してください。");
          const guide = getReferenceGuide(fishId.data);
          return guide
            ? json(guide)
            : errorResponse(404, "GUIDE_NOT_AVAILABLE", "この魚の参考手順はまだ登録されていません。");
        }
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
        || pathname === "/api/guide/analyze"
        || pathname === "/api/model/status"
        || pathname === "/api/config/orientation"
        || pathname === "/api/model/mock-observation"
        || pathname === "/api/guide/sessions"
        || sessionMatch !== null
        || advanceMatch !== null;
      if (!knownPath) return errorResponse(404, "NOT_FOUND", "指定されたAPIは見つかりません。");

      const allow = pathname === "/api/guide"
        ? "GET, POST"
        : pathname === "/api/guide/analyze"
          ? "POST"
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
} satisfies ExportedHandler<Env>;

export class GuideSessionStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS guide_sessions (
        session_id TEXT PRIMARY KEY,
        session_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS guide_session_creation_limits (
        client_hash TEXT PRIMARY KEY,
        tokens REAL NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS guide_image_analysis_limits (
        client_hash TEXT PRIMARY KEY,
        request_count INTEGER NOT NULL,
        window_started_at INTEGER NOT NULL
      )
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS guide_image_analysis_daily_limits (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        utc_day TEXT NOT NULL,
        request_count INTEGER NOT NULL
      )
    `);
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS guide_session_creation_limits_updated_at_idx ON guide_session_creation_limits (updated_at)",
    );
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS guide_sessions_updated_at_idx ON guide_sessions (updated_at)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      if (pathname === "/internal/gemini-analysis-limit" && request.method === "POST") {
        const clientHash = request.headers.get("x-client-hash");
        if (!clientHash || !/^[0-9a-f]{64}$/.test(clientHash)) return errorResponse(400, "BAD_REQUEST", "クライアント識別子を確認できません。");
        const now = Date.now();
        this.ctx.storage.sql.exec("DELETE FROM guide_image_analysis_limits WHERE window_started_at <= ?", now - analysisRateLimitWindowMs);
        const limit = this.ctx.storage.sql.exec<{ request_count: number; window_started_at: number }>(
          "SELECT request_count, window_started_at FROM guide_image_analysis_limits WHERE client_hash = ?",
          clientHash,
        ).toArray()[0];
        const requestLimit = this.env.GEMINI_TEST_MODE === "true"
          ? readTestInteger(this.env.GEMINI_TEST_ANALYSIS_LIMIT, 1_000, 1, 10_000)
          : analysisRateLimitCount;
        const dailyRequestLimit = this.env.GEMINI_TEST_MODE === "true"
          ? readTestInteger(this.env.GEMINI_TEST_DAILY_ANALYSIS_LIMIT, 10_000, 1, 100_000)
          : readConfiguredDailyAnalysisLimit(this.env.GEMINI_DAILY_ANALYSIS_LIMIT);
        if (limit && limit.request_count >= requestLimit) return errorResponse(429, "GEMINI_RATE_LIMITED", "画像確認の回数が上限に達しました。");
        const utcDay = new Date(now).toISOString().slice(0, 10);
        const dailyLimit = this.ctx.storage.sql.exec<{ utc_day: string; request_count: number }>(
          "SELECT utc_day, request_count FROM guide_image_analysis_daily_limits WHERE singleton_id = 1",
        ).toArray()[0];
        if (dailyLimit?.utc_day === utcDay && dailyLimit.request_count >= dailyRequestLimit) {
          return errorResponse(429, "GEMINI_DAILY_LIMIT_REACHED", "本日の画像確認回数の上限に達しました。明日以降に再度お試しください。");
        }
        if (limit) {
          this.ctx.storage.sql.exec("UPDATE guide_image_analysis_limits SET request_count = request_count + 1 WHERE client_hash = ?", clientHash);
        } else {
          this.ctx.storage.sql.exec(
            "INSERT INTO guide_image_analysis_limits (client_hash, request_count, window_started_at) VALUES (?, 1, ?)",
            clientHash,
            now,
          );
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO guide_image_analysis_daily_limits (singleton_id, utc_day, request_count)
           VALUES (1, ?, 1)
           ON CONFLICT(singleton_id) DO UPDATE SET
             utc_day = excluded.utc_day,
             request_count = CASE
               WHEN guide_image_analysis_daily_limits.utc_day = excluded.utc_day
               THEN guide_image_analysis_daily_limits.request_count + 1
               ELSE 1
             END`,
          utcDay,
        );
        return json({ allowed: true });
      }
      const sessionMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})$/i);
      const advanceMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})\/advance$/i);

      if (pathname === "/api/guide/sessions" && request.method === "POST") {
        const body = await readRequestBody(request);
        const parsed = GuideRequestSchema.safeParse(body);
        if (!parsed.success) return validationError();
        const guide = getReferenceGuide(parsed.data.fishId, parsed.data.preparationId);
        if (!guide) return errorResponse(404, "GUIDE_NOT_AVAILABLE", "この魚の参考手順はまだ登録されていません。");

        const now = Date.now();
        const clientHash = await hashClientAddress(request.headers.get("cf-connecting-ip") ?? "local-development");
        const staleLimitCutoff = now - sessionCreationLimitRetentionMs;
        this.ctx.storage.sql.exec(
          "DELETE FROM guide_session_creation_limits WHERE updated_at <= ?",
          staleLimitCutoff,
        );
        const clientLimit = this.ctx.storage.sql.exec<{ tokens: number; updated_at: number }>(
          "SELECT tokens, updated_at FROM guide_session_creation_limits WHERE client_hash = ?",
          clientHash,
        ).toArray()[0];
        const availableTokens = clientLimit
          ? Math.min(sessionCreationBucketCapacity, clientLimit.tokens + Math.max(0, now - clientLimit.updated_at) / sessionCreationRefillMs)
          : sessionCreationBucketCapacity;
        if (availableTokens < 1) {
          const retryAfterSeconds = Math.max(1, Math.ceil((1 - availableTokens) * sessionCreationRefillMs / 1000));
          return new Response(JSON.stringify({ error: {
            code: "SESSION_RATE_LIMITED",
            message: "ガイドの開始回数が上限に達しました。少し待ってから再試行してください。",
            details: { retryAfterSeconds },
          } }), {
            status: 429,
            headers: {
              "Cache-Control": "no-store",
              "Content-Type": "application/json; charset=utf-8",
              "Retry-After": String(retryAfterSeconds),
            },
          });
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO guide_session_creation_limits (client_hash, tokens, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(client_hash) DO UPDATE SET
             tokens = excluded.tokens,
             updated_at = excluded.updated_at`,
          clientHash,
          availableTokens - 1,
          now,
        );
        await this.scheduleCleanupAlarm();

        const expiryCutoff = new Date(Date.now() - guideSessionTtlMs).toISOString();
        this.ctx.storage.sql.exec("DELETE FROM guide_sessions WHERE updated_at <= ?", expiryCutoff);
        const count = this.ctx.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM guide_sessions",
        ).one().count;
        if (count >= maxGuideSessions) {
          return errorResponse(503, "SESSION_CAPACITY_REACHED", "保持中のガイドセッション数が上限に達しています。時間をおいて再試行してください。");
        }

        const session = createReferenceSession(parsed.data.fishId, parsed.data.preparationId, guide);
        this.storeSession(session);
        return json(session, 201);
      }

      if (sessionMatch && request.method === "GET") {
        const session = this.getActiveSession(sessionMatch[1]!);
        if (session) await this.scheduleCleanupAlarm();
        return session
          ? json(session)
          : errorResponse(404, "SESSION_NOT_FOUND", "ガイドセッションが見つかりません。");
      }

      if (advanceMatch && request.method === "POST") {
        const sessionId = advanceMatch[1]!;
        if (!this.getActiveSession(sessionId)) {
          return errorResponse(404, "SESSION_NOT_FOUND", "ガイドセッションが見つかりません。");
        }

        const body = await readRequestBody(request);
        const parsed = AdvanceGuideStepRequestSchema.safeParse(body);
        if (!parsed.success) return validationError();

        // Re-read after consuming the body so simultaneous advances cannot
        // both commit against the same stale step.
        const session = this.getActiveSession(sessionId);
        if (!session) return errorResponse(404, "SESSION_NOT_FOUND", "ガイドセッションが見つかりません。");
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
          currentStep: session.guide.steps[nextStepIndex] ?? null,
          currentStepIndex: nextStepIndex,
          completedStepIds,
          status: nextStepIndex >= session.guide.steps.length ? "completed" : "active",
          updatedAt: new Date().toISOString(),
        });
        this.storeSession(nextSession);
        await this.scheduleCleanupAlarm();
        return json(nextSession);
      }

      const knownPath = pathname === "/api/guide/sessions" || sessionMatch !== null || advanceMatch !== null;
      if (!knownPath) return errorResponse(404, "NOT_FOUND", "指定されたAPIは見つかりません。");
      const allow = pathname === "/api/guide/sessions" || advanceMatch ? "POST" : "GET";
      return new Response(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "このHTTPメソッドには対応していません。" } }), {
        status: 405,
        headers: { "Allow": allow, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (error instanceof RequestError) return errorResponse(error.status, error.code, error.message);
      throw error;
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM guide_session_creation_limits WHERE updated_at <= ?",
      now - sessionCreationLimitRetentionMs,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM guide_sessions WHERE updated_at <= ?",
      new Date(now - guideSessionTtlMs).toISOString(),
    );
    await this.scheduleCleanupAlarm();
  }

  private async scheduleCleanupAlarm(): Promise<void> {
    const oldestLimit = this.ctx.storage.sql.exec<{ updated_at: number | null }>(
      "SELECT MIN(updated_at) AS updated_at FROM guide_session_creation_limits",
    ).one().updated_at;
    const oldestSession = this.ctx.storage.sql.exec<{ updated_at: string | null }>(
      "SELECT MIN(updated_at) AS updated_at FROM guide_sessions",
    ).one().updated_at;
    const nextLimitCleanup = oldestLimit === null ? Number.POSITIVE_INFINITY : oldestLimit + sessionCreationLimitRetentionMs;
    const nextSessionCleanup = oldestSession === null ? Number.POSITIVE_INFINITY : Date.parse(oldestSession) + guideSessionTtlMs;
    const nextCleanupAt = Math.min(nextLimitCleanup, nextSessionCleanup);
    if (Number.isFinite(nextCleanupAt)) {
      await this.ctx.storage.setAlarm(Math.max(nextCleanupAt, Date.now() + 1));
    }
  }

  private getActiveSession(sessionId: string): GuideSession | null {
    const row = this.ctx.storage.sql.exec<{ session_json: string }>(
      "SELECT session_json FROM guide_sessions WHERE session_id = ?",
      sessionId,
    ).toArray()[0];
    if (!row) return null;

    const session = GuideSessionSchema.parse(JSON.parse(row.session_json) as unknown);
    if (Date.now() - Date.parse(session.updatedAt) >= guideSessionTtlMs) {
      this.deleteSession(sessionId);
      return null;
    }
    return session;
  }

  private storeSession(session: GuideSession): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO guide_sessions (session_id, session_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         session_json = excluded.session_json,
         updated_at = excluded.updated_at`,
      session.sessionId,
      JSON.stringify(session),
      session.updatedAt,
    );
  }

  private deleteSession(sessionId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM guide_sessions WHERE session_id = ?", sessionId);
  }
}

async function hashClientAddress(address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createReferenceSession(fishId: GuideSession["fishId"], preparationId: GuideSession["preparationId"], guide: NonNullable<ReturnType<typeof getReferenceGuide>>): GuideSession {
  const now = new Date().toISOString();
  return GuideSessionSchema.parse({
    sessionId: crypto.randomUUID(),
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

async function readRequestBody(request: Request, maxBytes = maxBodyBytes): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new RequestError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Typeにapplication/jsonを指定してください。");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestError(413, "PAYLOAD_TOO_LARGE", `リクエストのサイズが上限（${Math.round(maxBytes / 1024)} KiB）を超えています。`);
  }

  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "INVALID_JSON", "リクエスト本文が正しいJSON形式ではありません。");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new RequestError(413, "PAYLOAD_TOO_LARGE", `リクエストのサイズが上限（${Math.round(maxBytes / 1024)} KiB）を超えています。`);
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

async function analyzeWithGemini(
  env: Env,
  fishId: string,
  stepTitle: string,
  stepDescription: string,
  stepExpectedState: string,
  imageBase64: string,
  testScenario: string | null,
): Promise<GuideImageAnalysisResponse> {
  if (!env.GEMINI_API_KEY) {
    throw new RequestError(503, "GEMINI_NOT_CONFIGURED", "Gemini APIキーが設定されていません。apps/web/.dev.varsのGEMINI_API_KEYを確認してください。");
  }
  const model = env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite";
  const testMode = env.GEMINI_TEST_MODE === "true";
  const endpoint = geminiEndpoint(env, model, testMode);
  const maxAttempts = testMode ? readTestInteger(env.GEMINI_TEST_MAX_ATTEMPTS, 2, 1, 3) : 2;
  const attemptTimeoutMs = testMode ? readTestInteger(env.GEMINI_TEST_TIMEOUT_MS, 30_000, 50, 30_000) : 30_000;
  const overallTimeoutMs = testMode ? readTestInteger(env.GEMINI_TEST_OVERALL_TIMEOUT_MS, 35_000, 100, 35_000) : 35_000;
  const retryBaseDelayMs = testMode ? readTestInteger(env.GEMINI_TEST_RETRY_BASE_DELAY_MS, 250, 1, 2_000) : 250;
  const deadline = Date.now() + overallTimeoutMs;
  const requestBody = JSON.stringify({
    contents: [{ role: "user", parts: [
      { text: [
        "あなたは魚の調理工程を補助する画像確認役です。回答は日本語で、指定されたJSON形式だけにしてください。",
        "画像から直接見える事実だけを短く述べてください。魚種、鮮度、食用安全性、骨の完全な除去を保証してはいけません。",
        "visiblePartsでは画像内にはっきり見える頭・体・尾だけを返してください。",
        "stepAssessment.status は、この画像の見た目が現在の工程をどこまで示しているかを慎重に推定してください。",
        "likely_complete は工程完了を示す明確な見た目の証拠がある場合だけ、in_progress は明確に未完了と分かる場合だけにしてください。それ以外は uncertain にしてください。",
        "うろこ取りや小骨確認など、画像だけで作業結果を確かめられない工程は uncertain にしてください。期待状態のラベルだけから完了を推測してはいけません。",
        "工程の完了や安全性を保証せず、次の工程へ進めてもいけません。進行は利用者が操作します。",
        "不鮮明、隠れている、画角外など判断できない場合は certainty と stepAssessment.status の両方を uncertain にしてください。",
        `魚種ID: ${fishId}`,
        `確認中の工程: ${stepTitle}`,
        `表示中の参考ガイドの説明: ${stepDescription}`,
        `この工程の目安状態: ${stepExpectedState}`,
        "stepAssessment.evidence は工程の見た目について、画像で確認できた短い根拠を書いてください。evidence は見える部位の根拠、caution は必要な場合の短い注意です。",
      ].join("\n") },
      { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
    ] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
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
      },
    },
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw geminiTimeoutError();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(attemptTimeoutMs, remainingMs));
    const headers = new Headers({ "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY });
    if (testMode && testScenario && /^[a-z0-9_-]{1,40}$/i.test(testScenario)) headers.set("x-k6-scenario", testScenario);
    let response: Response;
    let responseText: string;
    try {
      response = await fetch(endpoint, { method: "POST", headers, body: requestBody, signal: controller.signal });
      responseText = await response.text();
    } catch {
      clearTimeout(timeoutId);
      const delayMs = retryBaseDelayMs * 2 ** (attempt - 1);
      if (attempt < maxAttempts && deadline - Date.now() > delayMs + 50) {
        await delayGeminiRetry(delayMs);
        continue;
      }
      if (controller.signal.aborted || Date.now() >= deadline) throw geminiTimeoutError();
      throw new RequestError(502, "GEMINI_UPSTREAM_ERROR", "Gemini APIへ接続できませんでした。時間をおいて再試行してください。");
    } finally {
      clearTimeout(timeoutId);
    }

    let payload: GeminiGenerateContentResponse | null = null;
    try {
      payload = JSON.parse(responseText) as GeminiGenerateContentResponse;
    } catch {
      // Invalid upstream JSON is reported below and is not retried.
    }

    if (!response.ok) {
      const retryDelayMs = geminiRetryDelay(response, payload, attempt, retryBaseDelayMs);
      if (retryDelayMs !== null && attempt < maxAttempts && deadline - Date.now() > retryDelayMs + 50) {
        await delayGeminiRetry(retryDelayMs);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new RequestError(502, "GEMINI_AUTH_FAILED", "Gemini APIキーを確認できませんでした。キー設定とGoogle AI Studioの利用権限を確認してください。");
      }
      if (response.status === 429 && isGeminiDailyQuotaError(payload)) {
        throw new RequestError(429, "GEMINI_QUOTA_EXCEEDED", "Gemini APIの利用枠を超えました。利用枠と請求設定を確認してください。");
      }
      if (response.status === 429) {
        throw new RequestError(429, "GEMINI_RATE_LIMITED", "Gemini APIの呼出し制限に達しました。時間をおいて再試行してください。");
      }
      throw new RequestError(502, "GEMINI_UPSTREAM_ERROR", "Gemini APIから応答を取得できませんでした。モデル名とAPIの状態を確認してください。");
    }

    try {
      const text = payload?.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
      if (!text) throw new Error("Empty Gemini response");
      const result = GuideImageAnalysisResultSchema.parse(JSON.parse(text) as unknown);
      return GuideImageAnalysisResponseSchema.parse({ ...result, model });
    } catch {
      throw new RequestError(502, "GEMINI_INVALID_RESPONSE", "Geminiの回答形式を確認できませんでした。もう一度お試しください。");
    }
  }
  throw geminiTimeoutError();
}

type GeminiGenerateContentResponse = {
  error?: { code?: number; status?: string; message?: string; details?: unknown };
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

function geminiEndpoint(env: Env, model: string, testMode: boolean): string {
  if (!testMode) return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  try {
    const endpoint = new URL(env.GEMINI_TEST_API_URL ?? "");
    const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    const expectedPath = `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    if (endpoint.protocol !== "http:" || !allowedHosts.has(endpoint.hostname.toLowerCase())
      || endpoint.pathname !== expectedPath || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
      throw new Error("The test endpoint must be a local GenerateContent URL for the configured model.");
    }
    return endpoint.toString();
  } catch {
    throw new RequestError(503, "GEMINI_TEST_ENDPOINT_INVALID", "ローカルGeminiテストURLはlocalhostのGenerateContentエンドポイントにしてください。");
  }
}

function readTestInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RequestError(503, "GEMINI_TEST_CONFIG_INVALID", "ローカルGeminiテスト設定の数値範囲を確認してください。");
  }
  return parsed;
}

function readConfiguredDailyAnalysisLimit(value: string | undefined): number {
  if (value === undefined) return 500;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw new RequestError(503, "GEMINI_LIMIT_CONFIG_INVALID", "Gemini画像確認の日次上限は1〜100000の整数にしてください。");
  }
  return parsed;
}

function isGeminiDailyQuotaError(payload: GeminiGenerateContentResponse | null): boolean {
  const error = payload?.error;
  const status = error?.status?.toLowerCase() ?? "";
  const description = (error?.message ?? "") + " " + JSON.stringify(error?.details ?? "");
  return status === "quota_exceeded"
    || /\bdaily quota\b|per[_ ]?day|requestsperday|tokensperday|\brpd\b/i.test(description);
}

function isGeminiErrorRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGeminiRetryInfoDelay(payload: GeminiGenerateContentResponse | null): number | null {
  const details = payload?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (!isGeminiErrorRecord(detail)
      || typeof detail["@type"] !== "string"
      || !detail["@type"].endsWith("google.rpc.RetryInfo")) continue;
    const retryDelay = detail.retryDelay;
    if (typeof retryDelay === "string") {
      const match = /^(\d+(?:\.\d{1,9})?)s$/.exec(retryDelay.trim());
      if (!match) return null;
      const milliseconds = Number(match[1]) * 1_000;
      return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.ceil(milliseconds) : null;
    }
    if (!isGeminiErrorRecord(retryDelay) || (!("seconds" in retryDelay) && !("nanos" in retryDelay))) return null;
    const seconds = Number(retryDelay.seconds ?? 0);
    const nanos = Number(retryDelay.nanos ?? 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos) || seconds < 0 || nanos < 0 || nanos >= 1_000_000_000) return null;
    const milliseconds = seconds * 1_000 + nanos / 1_000_000;
    return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : null;
  }
  return null;
}

function geminiRetryDelay(
  response: Response,
  payload: GeminiGenerateContentResponse | null,
  attempt: number,
  baseDelayMs: number,
): number | null {
  if (response.status !== 429 && (response.status < 500 || response.status > 599 || response.status === 501)) return null;
  if (response.status === 429 && isGeminiDailyQuotaError(payload)) return null;

  const retryHints = [
    parseRetryAfter(response.headers.get("retry-after")),
    parseGeminiRetryInfoDelay(payload),
  ].filter((delay): delay is number => delay !== null);
  if (retryHints.length > 0) {
    const retryDelayMs = Math.max(...retryHints);
    return retryDelayMs <= 2_000 ? retryDelayMs : null;
  }

  if (response.status === 429) {
    const status = payload?.error?.status?.toLowerCase() ?? "";
    const message = payload?.error?.message?.toLowerCase() ?? "";
    const appearsTransient = /rate.?limit|too many requests|resource_exhausted|requests per minute|tokens per minute|\brpm\b|\btpm\b/.test(status + " " + message);
    if (!appearsTransient) return null;
  }
  return Math.min(2_000, baseDelayMs * 2 ** (attempt - 1));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function delayGeminiRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function geminiTimeoutError(): RequestError {
  return new RequestError(504, "GEMINI_TIMEOUT", "Geminiへの接続がタイムアウトしました。少し待ってから再試行してください。");
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
