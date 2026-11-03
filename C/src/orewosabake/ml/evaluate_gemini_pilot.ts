import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG,
  FishIdSchema,
  getReferenceGuide,
  resolveGuideFishId,
  type FishId,
  type FishState,
} from "../packages/contracts/src/index.ts";
import {
  analyzeFishFrame,
  GeminiFishAnalysisError,
  GeminiFishAnalysisResultSchema,
} from "../apps/api/src/geminiVision.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(projectRoot, ".env");
const MAX_PILOT_CASES = 60;

type CsvRecord = Record<string, string>;
type PilotCase = {
  fishId: FishId;
  fishName: string;
  framePath: string;
  imagePath: string;
  confirmedStage: string;
  expectedState: FishState;
  currentStepId: string;
  contextSource: "manifest" | "fixed_first_step";
  sessionId: string;
  fishInstanceId: string;
};
type Attempt = PilotCase & {
  observedState: string;
  correct: string;
  status: string;
  error: string;
  elapsedMs: string;
};

const STATE_BY_CAPTURE_STAGE: Record<string, FishState> = {
  whole: "whole_fish",
  head_removed: "head_removed",
  gutted: "opened",
  filleting: "filleting",
  finished: "filleted",
  unknown: "unknown",
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSVの引用符が閉じられていません。");
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function getOptions(argv: string[]): { values: Map<string, string[]>; flags: Set<string> } {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const allowedValues = new Set(["--manifest", "--images-dir", "--output", "--delay-ms"]);
  const allowedFlags = new Set(["--confirm-google-upload", "--help"]);

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (allowedFlags.has(key)) {
      flags.add(key);
      continue;
    }
    if (!allowedValues.has(key) || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error(`引数が不明か、値がありません: ${key}`);
    }
    const entries = values.get(key) ?? [];
    entries.push(argv[index + 1]);
    values.set(key, entries);
    index += 1;
  }
  return { values, flags };
}

function usage(): string {
  return [
    "Gemini工程判定の小規模pilot評価",
    "",
    "npm run pilot:gemini -- `",
    '  --manifest "D:\\fish-pilot\\aji_capture-manifest.csv" `',
    '  --manifest "D:\\fish-pilot\\saba_capture-manifest.csv" `',
    '  --images-dir "D:\\fish-pilot" `',
    '  --output "D:\\fish-pilot\\gemini-results.csv" `',
    "  --confirm-google-upload",
    "",
    "CSVにcurrent_step_id列がなければ、魚種ごとの手順先頭を全画像で固定して使います。",
    "最大60枚をGoogle Geminiへ送信します。実行には .env のGEMINI_API_KEYと明示フラグが必要です。",
  ].join("\n");
}

function cell(row: CsvRecord, name: string): string {
  return (row[name] ?? "").trim();
}

function targetForStage(stage: string): FishState {
  const target = STATE_BY_CAPTURE_STAGE[stage];
  if (!target) throw new Error(`Geminiの状態へ変換できない工程ラベルです: ${stage || "(empty)"}`);
  return target;
}

async function loadCases(manifestPaths: string[], imagesDirectory: string): Promise<{ cases: PilotCase[]; excluded: number }> {
  const cases: PilotCase[] = [];
  let excluded = 0;

  for (const manifestPath of manifestPaths) {
    const matrix = parseCsv(await readFile(manifestPath, "utf8"));
    if (matrix.length < 2) continue;
    const headers = matrix[0].map((header) => header.trim());
    const required = ["fish_species", "session_id", "fish_id", "frame_path", "confirmed_stage", "review_status"];
    const missing = required.filter((header) => !headers.includes(header));
    if (missing.length > 0) throw new Error(`${basename(manifestPath)} に列がありません: ${missing.join(", ")}`);

    for (const values of matrix.slice(1)) {
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])) as CsvRecord;
      if (cell(row, "review_status") !== "reviewed") {
        excluded += 1;
        continue;
      }

      const stage = cell(row, "confirmed_stage");
      if (stage === "other") {
        excluded += 1;
        continue;
      }
      const expectedState = targetForStage(stage);
      const fishId = resolveGuideFishId(cell(row, "fish_species"));
      if (!fishId || !FishIdSchema.safeParse(fishId).success) {
        throw new Error(`Gemini未対応の魚種です: ${cell(row, "fish_species") || "(empty)"}`);
      }
      const guide = getReferenceGuide(fishId);
      if (!guide) throw new Error(`${fishId} の参考手順がありません。`);

      const suppliedStep = cell(row, "current_step_id");
      const currentStep = suppliedStep
        ? guide.steps.find((step) => step.id === suppliedStep)
        : guide.steps[0];
      if (!currentStep) {
        throw new Error(`${fishId} の手順に current_step_id=${suppliedStep} がありません。`);
      }

      const framePath = cell(row, "frame_path");
      if (!framePath) throw new Error("frame_pathが空の確認済み行があります。");
      const imagePath = resolve(imagesDirectory, framePath);
      const pathFromRoot = relative(resolve(imagesDirectory), imagePath);
      if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new Error(`frame_pathが画像フォルダーの外を指しています: ${framePath}`);
      }
      const image = await readFile(imagePath).catch(() => null);
      if (!image) throw new Error(`画像が見つかりません: ${imagePath}`);
      if (image.length > 520_000) {
        throw new Error(`${basename(imagePath)} が520KBを超えています。撮影アプリから保存した832px以下のJPEGを使ってください。`);
      }
      if (!imagePath.toLowerCase().endsWith(".jpg") && !imagePath.toLowerCase().endsWith(".jpeg")) {
        throw new Error(`${basename(imagePath)} はJPEGではありません。`);
      }
      if (image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
        throw new Error(`${basename(imagePath)} のJPEGシグネチャを確認できません。`);
      }

      cases.push({
        fishId,
        fishName: CATALOG.fish.find((fish) => fish.id === fishId)?.name ?? fishId,
        framePath,
        imagePath,
        confirmedStage: stage,
        expectedState,
        currentStepId: currentStep.id,
        contextSource: suppliedStep ? "manifest" : "fixed_first_step",
        sessionId: cell(row, "session_id"),
        fishInstanceId: cell(row, "fish_id"),
      });
    }
  }

  if (cases.length === 0) throw new Error("reviewedの工程画像がありません。画像とcapture-manifest.csvを確認してください。");
  return { cases, excluded };
}

async function main() {
  const { values, flags } = getOptions(process.argv.slice(2));
  if (flags.has("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const manifests = values.get("--manifest") ?? [];
  const imagesDir = values.get("--images-dir")?.[0];
  const outputPathValue = values.get("--output")?.[0];
  const delayMs = Number(values.get("--delay-ms")?.[0] ?? "8000");
  if (manifests.length === 0 || !imagesDir || !outputPathValue) {
    throw new Error(`必須引数がありません。\n\n${usage()}`);
  }
  if (!Number.isInteger(delayMs) || delayMs < 7_600) {
    throw new Error("--delay-msは7,600以上にしてください（APIの1分8回制限を超えないため）。");
  }

  const { cases, excluded } = await loadCases(manifests, resolve(imagesDir));
  if (cases.length > MAX_PILOT_CASES) {
    throw new Error(`一度に送信できる画像は${MAX_PILOT_CASES}枚までです。マニフェストを分けてください。`);
  }
  const outputPath = resolve(outputPathValue);
  process.stdout.write(`確認済み画像: ${cases.length}枚 / 対象外: ${excluded}行\n`);
  process.stdout.write("送信先: Google Gemini API（画像はGoogleへ送信されます）\n");
  process.stdout.write(`比較用ステップ: ${cases.some((item) => item.contextSource === "manifest") ? "CSV列のcurrent_step_idを使用" : "魚種ごとに手順先頭を固定"}\n`);

  if (!flags.has("--confirm-google-upload")) {
    throw new Error("画像送信は停止しました。内容に同意した場合だけ --confirm-google-upload を付けて再実行してください。");
  }
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEYがありません。.envまたは環境変数に設定してください。");

  await mkdir(dirname(outputPath), { recursive: true });
  const outputExists = await access(outputPath).then(() => true, () => false);
  if (outputExists) throw new Error(`結果ファイルが既にあります。別の --output を指定してください: ${outputPath}`);

  const attempts: Attempt[] = [];
  let stoppedByError = "";
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    if (stoppedByError) {
      attempts.push({ ...item, observedState: "", correct: "", status: "skipped", error: stoppedByError, elapsedMs: "0" });
      continue;
    }
    const image = await readFile(item.imagePath);
    const imageBase64 = image.toString("base64");
    const startedAt = Date.now();

    try {
      const result = await analyzeFishFrame({
        fishId: item.fishId,
        currentStepId: item.currentStepId,
        imageBase64,
        mediaPipeObservation: null,
      }, {
        apiKey,
        model: process.env.GEMINI_MODEL,
        timeoutMs: 55_000,
        overallTimeoutMs: 60_000,
        maxAttempts: 1,
      });
      const parsed = GeminiFishAnalysisResultSchema.safeParse(result);
      if (!parsed.success) throw new Error("Gemini応答の形式が想定と異なります。");
      const observedState = parsed.data.observedState;
      attempts.push({
        ...item,
        observedState,
        correct: observedState === item.expectedState ? "true" : "false",
        status: "200",
        error: "",
        elapsedMs: String(Date.now() - startedAt),
      });
      process.stdout.write(`[${index + 1}/${cases.length}] ${item.framePath}: ${observedState} / 正解 ${item.expectedState}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "不明なエラー";
      const status = error instanceof GeminiFishAnalysisError ? String(error.status) : "error";
      attempts.push({ ...item, observedState: "", correct: "", status, error: message, elapsedMs: String(Date.now() - startedAt) });
      stoppedByError = `前の画像のGemini API呼び出しが失敗したため未送信（${status}）`;
      process.stdout.write(`[${index + 1}/${cases.length}] ${item.framePath}: 通信失敗（以後は送信を停止）\n`);
    }

    if (index < cases.length - 1 && !stoppedByError) await new Promise((done) => setTimeout(done, delayMs));
  }

  const columns = [
    "fish_id", "fish_species", "session_id", "fish_instance_id", "frame_path", "confirmed_stage",
    "expected_api_state", "gemini_observed_state", "correct", "current_step_id", "context_source",
    "api_status", "error", "elapsed_ms",
  ] as const;
  const outputRows = attempts.map((item) => [
    item.fishId, item.fishName, item.sessionId, item.fishInstanceId, item.framePath, item.confirmedStage,
    item.expectedState, item.observedState, item.correct, item.currentStepId, item.contextSource,
    item.status, item.error, item.elapsedMs,
  ]);
  const csv = [columns.join(","), ...outputRows.map((row) => row.map((value) => csvEscape(String(value))).join(","))].join("\r\n") + "\r\n";
  await writeFile(outputPath, csv, { encoding: "utf8", flag: "wx" });

  const successful = attempts.filter((item) => item.status === "200");
  const correct = successful.filter((item) => item.correct === "true").length;
  const failed = attempts.filter((item) => item.status !== "200" && item.status !== "skipped").length;
  const skipped = attempts.filter((item) => item.status === "skipped").length;
  if (successful.length === 0) {
    process.stdout.write(`\n結果: Gemini応答なし（失敗 ${failed}件 / 未送信 ${skipped}件）。正解率は未算出です。\n`);
  } else {
    process.stdout.write(`\n結果: ${correct}/${successful.length}枚 正解（失敗 ${failed}件 / 未送信 ${skipped}件）\n`);
  }
  const states = [...new Set(attempts.map((item) => item.expectedState))];
  for (const state of states) {
    const classRows = successful.filter((item) => item.expectedState === state);
    const classCorrect = classRows.filter((item) => item.correct === "true").length;
    process.stdout.write(`  ${state}: ${classCorrect}/${classRows.length}\n`);
  }
  const predictedStates = [...new Set(successful.map((item) => item.observedState))];
  if (successful.length > 0) {
    process.stdout.write("\n混同行列（行=人手ラベル、列=Gemini予測）\n");
    process.stdout.write(["expected\\predicted", ...predictedStates].join(",") + "\n");
    for (const expected of states) {
      const counts = predictedStates.map((predicted) => successful.filter(
        (item) => item.expectedState === expected && item.observedState === predicted,
      ).length);
      process.stdout.write([expected, ...counts].join(",") + "\n");
    }
  }
  process.stdout.write(`結果CSV: ${outputPath}\n`);
  process.stdout.write("これは小規模pilotの記述結果です。独立個体・撮影条件を増やすまで一般精度とは扱わないでください。\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "不明なエラー";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

