import http from "k6/http";
import { check } from "k6";

const baseUrl = __ENV.BASE_URL ?? "http://127.0.0.1:8787";
const mockUrl = __ENV.MOCK_URL ?? "http://127.0.0.1:8789";
const profile = __ENV.K6_PROFILE ?? "smoke";
const loadRate = Number(__ENV.K6_RATE ?? 5);
const loadVUs = Number(__ENV.K6_MAX_VUS ?? Math.max(1, Math.ceil(loadRate)));
const requestBody = {
  fishId: "saba",
  stepId: "saba_prepare",
  imageData: "data:image/jpeg;base64,a2Y2LXRlc3QtZmlzaA==",
};

const smokeCases = [
  { scenario: "success", expectedStatus: 200 },
  { scenario: "transient_503", expectedStatus: 200 },
  { scenario: "persistent_503", expectedStatus: 502, expectedCode: "GEMINI_UPSTREAM_ERROR" },
  { scenario: "transient_429", expectedStatus: 200 },
  { scenario: "resource_exhausted_429", expectedStatus: 200 },
  { scenario: "quota_429", expectedStatus: 429, expectedCode: "GEMINI_QUOTA_EXCEEDED" },
  { scenario: "slow_success", expectedStatus: 200 },
  { scenario: "timeout", expectedStatus: 504, expectedCode: "GEMINI_TIMEOUT" },
  { scenario: "invalid_output", expectedStatus: 502, expectedCode: "GEMINI_INVALID_RESPONSE" },
  { scenario: "auth_401", expectedStatus: 502, expectedCode: "GEMINI_AUTH_FAILED" },
  { scenario: "network_retry", expectedStatus: 200 },
  { scenario: "success", expectedStatus: 422, expectedCode: "VALIDATION_ERROR", invalidPayload: true },
];

export const options = profile === "load"
  ? {
      scenarios: {
        local_worker_load: {
          executor: "constant-arrival-rate",
          rate: loadRate,
          timeUnit: "1s",
          duration: "10s",
          preAllocatedVUs: loadVUs,
          maxVUs: loadVUs,
        },
      },
      thresholds: {
        checks: ["rate>0.99"],
        http_req_failed: ["rate<0.01"],
        http_req_duration: ["p(95)<1000"],
        dropped_iterations: ["count==0"],
      },
    }
  : {
      scenarios: {
        failure_modes: {
          executor: "per-vu-iterations",
          vus: 1,
          iterations: smokeCases.length,
          maxDuration: "30s",
        },
      },
      thresholds: {
        checks: ["rate==1"],
        http_req_duration: ["p(95)<2000"],
      },
    };

function postScenario(scenario, expectedStatus, expectedCode, invalidPayload = false) {
  const payload = invalidPayload ? { ...requestBody, imageData: "not-base64" } : requestBody;
  const response = http.post(`${baseUrl}/api/guide/analyze`, JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "X-K6-Scenario": scenario,
    },
    tags: { scenario },
  });
  let body;
  try {
    body = response.json();
  } catch {
    body = null;
  }
  check(response, {
    [`${scenario}: expected HTTP ${expectedStatus}`]: (res) => res.status === expectedStatus,
    [`${scenario}: expected valid analysis or error code`]: () => expectedCode
      ? body?.error?.code === expectedCode
      : body?.model === "gemini-3.5-flash-lite"
        && body?.certainty === "uncertain"
        && body?.stepAssessment?.status === "uncertain",
  });
}

export default function () {
  if (profile === "load") {
    postScenario("success", 200);
    return;
  }
  const testCase = smokeCases[__ITER];
  if (!testCase) return;
  postScenario(testCase.scenario, testCase.expectedStatus, testCase.expectedCode, testCase.invalidPayload);
}

export function teardown() {
  if (profile !== "smoke") return;
  const response = http.get(`${mockUrl}/__test/stats`);
  let counts = {};
  try {
    counts = response.json().counts ?? {};
  } catch {
    // The assertion below reports a useful failure when the mock is unavailable.
  }
  const expected = {
    success: 1,
    transient_503: 2,
    persistent_503: 2,
    transient_429: 2,
    resource_exhausted_429: 2,
    quota_429: 1,
    slow_success: 1,
    timeout: 2,
    invalid_output: 1,
    auth_401: 1,
    network_retry: 2,
  };
  check(response, {
    "fake Gemini received the expected retries and rejected cases": (res) => res.status === 200
      && Object.entries(expected).every(([scenario, count]) => counts[scenario] === count)
      && Object.keys(counts).every((scenario) => scenario in expected),
  });
}
