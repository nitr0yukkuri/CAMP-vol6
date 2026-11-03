import http from "k6/http";
import { check } from "k6";

const baseUrl = __ENV.BASE_URL ?? "http://127.0.0.1:8787";
const mockUrl = __ENV.MOCK_URL ?? "http://127.0.0.1:8789";
const requestBody = {
  fishId: "saba",
  stepId: "saba_prepare",
  imageData: "data:image/jpeg;base64,a2Y2LXRlc3QtZmlzaA==",
};

export const options = {
  scenarios: {
    daily_limit: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 2,
      maxDuration: "15s",
    },
  },
  thresholds: {
    checks: ["rate==1"],
    http_req_duration: ["p(95)<2000"],
  },
};

export default function () {
  const response = http.post(`${baseUrl}/api/guide/analyze`, JSON.stringify(requestBody), {
    headers: {
      "Content-Type": "application/json",
      "X-K6-Scenario": "success",
    },
  });
  let body;
  try {
    body = response.json();
  } catch {
    body = null;
  }

  if (__ITER === 0) {
    check(response, {
      "daily limit allows the first request": (res) => res.status === 200,
      "first request returns a valid Gemini response": () => body?.certainty === "uncertain"
        && body?.stepAssessment?.status === "uncertain",
    });
    return;
  }

  check(response, {
    "daily limit rejects the next request": (res) => res.status === 429,
    "daily limit error is preserved through the Worker": () => body?.error?.code === "GEMINI_DAILY_LIMIT_REACHED",
  });
}

export function teardown() {
  const response = http.get(`${mockUrl}/__test/stats`);
  let counts = {};
  try {
    counts = response.json().counts ?? {};
  } catch {
    // A failed stats check explains when the mock API was unavailable.
  }
  check(response, {
    "only the allowed request reached fake Gemini": (res) => res.status === 200
      && counts.success === 1
      && Object.keys(counts).every((scenario) => scenario === "success"),
  });
}
