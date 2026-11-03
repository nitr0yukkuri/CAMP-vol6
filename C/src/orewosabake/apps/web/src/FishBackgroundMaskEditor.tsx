import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { FishMaskStroke, FishMaskWorkerRequest, FishMaskWorkerResponse } from "./model/fishMaskWorkerProtocol";

const MASK_MODEL_PATH = "https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/1/interactive_segmentation.task";
const MASK_WASM_PATH = "/mediapipe/wasm";
const MAX_STROKES = 32;

type Props = {
  sourceBlob: Blob;
  sourceUrl: string;
  width: number;
  height: number;
  onExport: (blob: Blob) => void;
};

type PendingRequest = {
  resolve: (result: Extract<FishMaskWorkerResponse, { type: "result" }>) => void;
  reject: (error: Error) => void;
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function makeTransparentPng(
  sourceBlob: Blob,
  width: number,
  height: number,
  maskWidth: number,
  maskHeight: number,
  mask: Float32Array,
): Promise<{ blob: Blob; coverage: number }> {
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("透過画像を作るためのCanvasを利用できません。");
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    let selected = 0;
    for (let y = 0; y < height; y += 1) {
      const maskY = Math.min(maskHeight - 1, Math.floor((y + 0.5) * maskHeight / height));
      for (let x = 0; x < width; x += 1) {
        const maskX = Math.min(maskWidth - 1, Math.floor((x + 0.5) * maskWidth / width));
        const maskValue = mask[maskY * maskWidth + maskX] ?? 0;
        const alpha = Math.max(0, Math.min(1, (maskValue - 0.28) / 0.55));
        const pixelIndex = (y * width + x) * 4;
        pixels.data[pixelIndex + 3] = Math.round((pixels.data[pixelIndex + 3] ?? 0) * alpha);
        if (maskValue >= 0.5) selected += 1;
      }
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("PNGを作成できませんでした。")), "image/png");
    });
    return { blob, coverage: selected / (maskWidth * maskHeight) };
  } finally {
    bitmap.close();
  }
}

export function FishBackgroundMaskEditor({ sourceBlob, sourceUrl, width, height, onExport }: Props) {
  const workerRef = useRef<Worker | null>(null);
  const readyRef = useRef<Promise<void> | null>(null);
  const readyResolveRef = useRef<(() => void) | null>(null);
  const readyRejectRef = useRef<((error: Error) => void) | null>(null);
  const pendingRequests = useRef(new Map<number, PendingRequest>());
  const requestId = useRef(0);
  const strokesRef = useRef<FishMaskStroke[]>([]);
  const imageSetRef = useRef(false);
  const candidateUrlRef = useRef<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState("背景を抜く場合は、まず切り抜きモデルを読み込みます。");
  const [mode, setMode] = useState<FishMaskStroke["mode"]>("include");
  const [strokes, setStrokes] = useState<FishMaskStroke[]>([]);
  const [busy, setBusy] = useState(false);
  const [candidateBlob, setCandidateBlob] = useState<Blob | null>(null);
  const [candidateUrl, setCandidateUrl] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<number | null>(null);
  const [maskConfirmed, setMaskConfirmed] = useState(false);
  const [exported, setExported] = useState(false);

  useEffect(() => () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    pendingRequests.current.forEach(({ reject }) => reject(new Error("切り抜き処理を終了しました。")));
    pendingRequests.current.clear();
    if (candidateUrlRef.current) URL.revokeObjectURL(candidateUrlRef.current);
  }, []);

  function replaceCandidateUrl(nextUrl: string | null) {
    const previous = candidateUrlRef.current;
    candidateUrlRef.current = nextUrl;
    setCandidateUrl(nextUrl);
    if (previous) URL.revokeObjectURL(previous);
  }

  function getWorker(): Worker {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL("./workers/fishMask.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<FishMaskWorkerResponse>) => {
      const response = event.data;
      if (response.type === "ready") {
        readyResolveRef.current?.();
        readyResolveRef.current = null;
        readyRejectRef.current = null;
        setStatus("ready");
        return;
      }
      if (response.type === "error") {
        const error = new Error(response.message);
        if (response.requestId === undefined) {
          readyRejectRef.current?.(error);
          readyResolveRef.current = null;
          readyRejectRef.current = null;
          setStatus("error");
          setMessage(`切り抜きモデルを読み込めませんでした。${response.message}`);
          return;
        }
        const pending = pendingRequests.current.get(response.requestId);
        pendingRequests.current.delete(response.requestId);
        pending?.reject(error);
        return;
      }
      const pending = pendingRequests.current.get(response.requestId);
      pendingRequests.current.delete(response.requestId);
      pending?.resolve(response);
    });
    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "切り抜きWorkerを起動できませんでした。");
      readyRejectRef.current?.(error);
      readyResolveRef.current = null;
      readyRejectRef.current = null;
      pendingRequests.current.forEach(({ reject }) => reject(error));
      pendingRequests.current.clear();
      setStatus("error");
      setMessage(error.message);
    });
    workerRef.current = worker;
    return worker;
  }

  function initialize(): Promise<void> {
    if (readyRef.current) return readyRef.current;
    setStatus("loading");
    setMessage("端末内で使う切り抜きモデルを読み込んでいます…");
    const worker = getWorker();
    readyRef.current = new Promise<void>((resolve, reject) => {
      readyResolveRef.current = resolve;
      readyRejectRef.current = reject;
      worker.postMessage({ type: "initialize", wasmPath: MASK_WASM_PATH, modelPath: MASK_MODEL_PATH } satisfies FishMaskWorkerRequest);
    }).then(() => {
      setMessage("準備できました。左の元画像で魚の上をタップしてください。");
    }).catch((error: unknown) => {
      readyRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
      const messageText = toError(error).message;
      setStatus("error");
      setMessage(`モデルを読み込めませんでした。${messageText}`);
      throw error;
    });
    return readyRef.current;
  }

  function requestMask(strokeList: FishMaskStroke[], bitmap?: ImageBitmap): Promise<Extract<FishMaskWorkerResponse, { type: "result" }>> {
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error("切り抜きモデルを読み込んでください。"));
    const id = ++requestId.current;
    return new Promise((resolve, reject) => {
      pendingRequests.current.set(id, { resolve, reject });
      if (bitmap) {
        worker.postMessage({ type: "select", requestId: id, bitmap, strokes: strokeList } satisfies FishMaskWorkerRequest, [bitmap]);
      } else {
        worker.postMessage({ type: "refine", requestId: id, strokes: strokeList } satisfies FishMaskWorkerRequest);
      }
    });
  }

  async function runMask(nextStrokes: FishMaskStroke[], resetImage: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMaskConfirmed(false);
    setExported(false);
    try {
      const ready = await initialize();
      void ready;
      const bitmap = resetImage ? await createImageBitmap(sourceBlob) : undefined;
      const result = await requestMask(nextStrokes, bitmap);
      imageSetRef.current = true;
      const mask = new Float32Array(result.maskBuffer);
      const candidate = await makeTransparentPng(sourceBlob, width, height, result.width, result.height, mask);
      const nextUrl = URL.createObjectURL(candidate.blob);
      replaceCandidateUrl(nextUrl);
      setCandidateBlob(candidate.blob);
      setCoverage(candidate.coverage);
      setMessage(candidate.coverage < 0.01 || candidate.coverage > 0.98
        ? "魚の範囲が極端です。魚と背景の両方をタップして、選択を直してください。"
        : "切り抜き候補です。輪郭の欠けや背景の残りを右のプレビューで確認してください。");
    } catch (error) {
      setMessage(`切り抜きを作れませんでした。${toError(error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function imagePoint(event: ReactPointerEvent<HTMLImageElement>): { x: number; y: number } {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  async function markImage(event: ReactPointerEvent<HTMLImageElement>) {
    if (status !== "ready" || busy) return;
    event.preventDefault();
    if (strokesRef.current.length >= MAX_STROKES) {
      setMessage(`修正点は最大${MAX_STROKES}個です。不要な点を戻してから追加してください。`);
      return;
    }
    const next = [...strokesRef.current, { mode, points: [imagePoint(event)] }];
    strokesRef.current = next;
    setStrokes(next);
    await runMask(next, !imageSetRef.current);
  }

  async function undoStroke() {
    const next = strokesRef.current.slice(0, -1);
    strokesRef.current = next;
    setStrokes(next);
    if (next.length === 0) {
      setCandidateBlob(null);
      setCoverage(null);
      setMaskConfirmed(false);
      imageSetRef.current = false;
      setMessage("魚の上をタップして切り抜きを作ってください。");
      replaceCandidateUrl(null);
      return;
    }
    await runMask(next, false);
  }

  function resetMask() {
    strokesRef.current = [];
    setStrokes([]);
    setCandidateBlob(null);
    setCoverage(null);
    setMaskConfirmed(false);
    setExported(false);
    imageSetRef.current = false;
    setMessage("元画像に戻しました。必要なら切り抜きをやり直せます。");
    replaceCandidateUrl(null);
  }

  const coverageIsUsable = coverage !== null && coverage >= 0.01 && coverage <= 0.98;

  return (
    <div className="fish-mask-editor">
      <div className="fish-mask-heading">
        <strong>背景を透過したPNGを別保存</strong>
        <p>元の撮影JPEGとCSVは変更しません。切り抜きは端末内で行い、モデル取得だけGoogleへ通信します。</p>
      </div>
      {status === "idle" || status === "error" ? (
        <button type="button" className="fish-mask-start" onClick={() => { void initialize().catch(() => undefined); }}>
          {status === "error" ? "もう一度読み込む" : "切り抜きモデルを読み込む"}
        </button>
      ) : null}
      <p className="fish-mask-message" role="status">{busy ? "魚の輪郭を計算しています…" : message}</p>
      <div className="fish-mask-tools">
        <button type="button" className={mode === "include" ? "is-active" : ""} onClick={() => setMode("include")} disabled={status !== "ready" || busy}>魚を追加</button>
        <button type="button" className={mode === "exclude" ? "is-active" : ""} onClick={() => setMode("exclude")} disabled={status !== "ready" || busy}>背景を除外</button>
        <button type="button" onClick={() => void undoStroke()} disabled={strokes.length === 0 || busy}>ひとつ戻す</button>
      </div>
      <div className="fish-mask-workspace">
        <figure>
          <figcaption>元画像 · 魚または背景をタップ</figcaption>
          <img
            src={sourceUrl}
            alt="背景透過の元画像"
            onPointerUp={(event) => { void markImage(event); }}
            className={status === "ready" ? "is-selectable" : ""}
          />
        </figure>
        <figure className="fish-mask-result">
          <figcaption>透過候補</figcaption>
          {candidateUrl ? <img src={candidateUrl} alt="透明な背景の切り抜き候補" /> : <div className="fish-mask-empty">魚をタップすると<br />ここに表示されます</div>}
        </figure>
      </div>
      {candidateBlob ? (
        <label className="fish-mask-confirm">
          <input type="checkbox" checked={maskConfirmed} onChange={(event) => setMaskConfirmed(event.currentTarget.checked)} />
          魚の輪郭が残り、背景だけが透過していることを確認した
        </label>
      ) : null}
      <div className="fish-mask-actions">
        <button type="button" onClick={resetMask} disabled={busy || (!candidateBlob && strokes.length === 0)}>切り抜きをリセット</button>
        <button type="button" className="is-primary" onClick={() => {
          if (!candidateBlob || !maskConfirmed || !coverageIsUsable || busy) return;
          onExport(candidateBlob);
          setExported(true);
          setMessage("透過PNGを別ファイルで保存しました。元画像とCSVはそのままです。");
        }} disabled={!candidateBlob || !maskConfirmed || !coverageIsUsable || busy}>
          {exported ? "透過PNGを保存済み" : "確認した切り抜きPNGを保存"}
        </button>
      </div>
    </div>
  );
}

