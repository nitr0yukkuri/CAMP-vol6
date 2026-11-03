import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.MOCK_GEMINI_PORT ?? 8789);
const expectedKey = "k6-fake-local-only";
const expectedModel = "gemini-3.5-flash-lite";
const counts = new Map();
const successfulResult = {
  certainty: "uncertain",
  visibleParts: [],
  fishStateAssessment: { state: "unknown", evidence: "合成テスト画像だけでは魚体の状態を区別できません。" },
  stepAssessment: { status: "uncertain", evidence: "合成テスト画像だけでは判断できません。" },
  evidence: "合成テスト画像だけでは魚の状態を確認できません。",
  caution: "この応答はローカルの偽APIです。",
};
const nonSalmonResult = {
  certainty: "uncertain",
  visibleParts: [],
  stepAssessment: { status: "uncertain", evidence: "現在画像だけでは判断できません。" },
  evidence: "現在画像だけでは魚の状態を確認できません。",
  caution: "この応答はローカルの偽APIです。",
};

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > 1_000_000) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function generatedContent(output = successfulResult) {
  return {
    candidates: [{
      content: { role: "model", parts: [{ text: JSON.stringify(output) }] },
      finishReason: "STOP",
    }],
  };
}

function errorBody(status, message) {
  return { error: { code: status, status, message } };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/__test/stats") {
    return sendJson(response, 200, { counts: Object.fromEntries(counts) });
  }
  const modelMatch = url.pathname.match(/^\/v1beta\/models\/([^/]+):generateContent$/);
  if (request.method !== "POST" || !modelMatch) {
    return sendJson(response, 404, { error: { status: "NOT_FOUND" } });
  }
  if (request.headers["x-goog-api-key"] !== expectedKey) {
    return sendJson(response, 401, errorBody("UNAUTHENTICATED", "Invalid fake key"));
  }

  const scenario = String(request.headers["x-k6-scenario"] ?? "success");
  const count = (counts.get(scenario) ?? 0) + 1;
  counts.set(scenario, count);

  let body;
  try {
    body = await readJson(request);
  } catch {
    return sendJson(response, 400, errorBody("INVALID_ARGUMENT", "Invalid JSON"));
  }
  const parts = body.contents?.[0]?.parts;
  const inlineImages = Array.isArray(parts)
    ? parts.filter((part) => part?.inlineData?.mimeType === "image/jpeg" && typeof part.inlineData.data === "string" && part.inlineData.data.length > 0)
    : [];
  const hasPrompt = Array.isArray(parts) && parts.some((part) => typeof part?.text === "string");
  const promptText = Array.isArray(parts)
    ? parts.filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n")
    : "";
  const expectsFishState = promptText.includes("魚種ID: salmon");
  const hasFishStateSchema = Boolean(body.generationConfig?.responseSchema?.properties?.fishStateAssessment?.properties?.state);
  const hasGuideResponseSchema = body.generationConfig?.responseMimeType === "application/json"
    && body.generationConfig?.responseSchema?.properties?.stepAssessment?.properties?.status;
  const expectedImageCount = expectsFishState ? 2 : 1;
  if (decodeURIComponent(modelMatch[1]) !== expectedModel
    || inlineImages.length !== expectedImageCount
    || hasFishStateSchema !== expectsFishState
    || !hasPrompt
    || !hasGuideResponseSchema) {
    return sendJson(response, 400, errorBody("INVALID_ARGUMENT", "Unexpected GenerateContent request"));
  }

  if (scenario === "transient_503" && count === 1) {
    return sendJson(response, 503, errorBody("UNAVAILABLE", "Service temporarily unavailable"));
  }
  if (scenario === "persistent_503") {
    return sendJson(response, 503, errorBody("UNAVAILABLE", "Service temporarily unavailable"));
  }
  if (scenario === "transient_429" && count === 1) {
    return sendJson(response, 429, errorBody("RATE_LIMIT_EXCEEDED", "Requests per minute limit"), { "Retry-After": "0.02" });
  }
  if (scenario === "resource_exhausted_429" && count === 1) {
    return sendJson(response, 429, errorBody("RESOURCE_EXHAUSTED", "Rate limit reached"), { "Retry-After": "0.02" });
  }
  if (scenario === "quota_429") {
    return sendJson(response, 429, errorBody("QUOTA_EXCEEDED", "Daily quota exceeded"));
  }
  if (scenario === "auth_401") {
    return sendJson(response, 401, errorBody("UNAUTHENTICATED", "Invalid fake key"));
  }
  if (scenario === "network_retry" && count === 1) {
    response.destroy();
    return;
  }
  if (scenario === "slow_success") await new Promise((resolve) => setTimeout(resolve, 250));
  if (scenario === "timeout") await new Promise((resolve) => setTimeout(resolve, 1_500));
  if (scenario === "invalid_output") return sendJson(response, 200, { candidates: [{ content: { parts: [{ text: "not JSON" }] } }] });
  if (response.destroyed) return;
  return sendJson(response, 200, generatedContent(scenario === "non_salmon_success" ? nonSalmonResult : successfulResult));
});

server.listen(port, host, () => {
  process.stdout.write(`Fake Gemini API listening at http://${host}:${port}\n`);
});

function stop() {
  process.stdout.write(`Fake Gemini request counts: ${JSON.stringify(Object.fromEntries(counts))}\n`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
