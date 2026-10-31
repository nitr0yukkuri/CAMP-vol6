import { DurableObject } from "cloudflare:workers";
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
const sessionCreationBucketCapacity = 10;
const sessionCreationRefillMs = 10 * 1000;

interface Env {
  GUIDE_SESSIONS: DurableObjectNamespace<GuideSessionStore>;
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
    const { pathname } = new URL(request.url);

    const sessionMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})$/i);
    const advanceMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})\/advance$/i);

    if (pathname === "/api/guide/sessions" || sessionMatch || advanceMatch) {
      const durableRequest = new Request(new URL(pathname, "https://guide-session.internal"), request);
      return env.GUIDE_SESSIONS.getByName("guide-sessions").fetch(durableRequest);
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
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS guide_session_creation_limits_updated_at_idx ON guide_session_creation_limits (updated_at)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      const sessionMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})$/i);
      const advanceMatch = pathname.match(/^\/api\/guide\/sessions\/([0-9a-f-]{36})\/advance$/i);

      if (pathname === "/api/guide/sessions" && request.method === "POST") {
        const body = await readRequestBody(request);
        const parsed = GuideRequestSchema.safeParse(body);
        if (!parsed.success) return validationError();

        const now = Date.now();
        const clientHash = await hashClientAddress(request.headers.get("cf-connecting-ip") ?? "local-development");
        const staleLimitCutoff = now - sessionCreationBucketCapacity * sessionCreationRefillMs;
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

        const expiryCutoff = new Date(Date.now() - guideSessionTtlMs).toISOString();
        this.ctx.storage.sql.exec("DELETE FROM guide_sessions WHERE updated_at <= ?", expiryCutoff);
        const count = this.ctx.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM guide_sessions",
        ).one().count;
        if (count >= maxGuideSessions) {
          return errorResponse(503, "SESSION_CAPACITY_REACHED", "保持中のガイドセッション数が上限に達しています。時間をおいて再試行してください。");
        }

        const session = createMockSession(parsed.data.fishId, parsed.data.preparationId);
        this.storeSession(session);
        return json(session, 201);
      }

      if (sessionMatch && request.method === "GET") {
        const session = this.getActiveSession(sessionMatch[1]!);
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
          currentStep: MOCK_GUIDE.steps[nextStepIndex] ?? null,
          currentStepIndex: nextStepIndex,
          completedStepIds,
          status: nextStepIndex >= MOCK_GUIDE.steps.length ? "completed" : "active",
          updatedAt: new Date().toISOString(),
        });
        this.storeSession(nextSession);
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
