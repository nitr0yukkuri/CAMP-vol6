import { useEffect, useState, type RefObject } from "react";
import type { Observation } from "@orewosabake/contracts";

export type HeadTailDetectionStatus = "idle" | "loading" | "active" | "paused" | "unavailable" | "error";

export type HeadTailDetection = {
  status: HeadTailDetectionStatus;
  message: string;
  observation: Observation | null;
};

const MODEL_PATH = "/models/head-tail.tflite";
const INFERENCE_INTERVAL_MS = 1_000;

export function useHeadTailDetection(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
): HeadTailDetection {
  const [detection, setDetection] = useState<HeadTailDetection>({
    status: "idle",
    message: "カメラ起動後に認識モデルを確認します。",
    observation: null,
  });

  useEffect(() => {
    if (!enabled) {
      setDetection({
        status: "idle",
        message: "カメラ起動後に認識モデルを確認します。",
        observation: null,
      });
      return;
    }

    let disposed = false;
    let inferenceInFlight = false;
    let intervalId: number | undefined;
    let detector: import("../model/mediapipeHeadTailDetector").MediaPipeHeadTailDetector | null = null;
    let removeVisibilityListener: (() => void) | undefined;

    setDetection({ status: "loading", message: "認識モデルを読み込んでいます。", observation: null });

    async function initialize() {
      let modelMissing = false;

      try {
        const modelResponse = await fetch(MODEL_PATH, { method: "HEAD", cache: "no-store" });
        const contentType = modelResponse.headers.get("content-type")?.toLowerCase() ?? "";
        if (!modelResponse.ok || contentType.includes("text/html")) {
          modelMissing = true;
          throw new Error("Fish detection model is not installed");
        }

        const { MediaPipeHeadTailDetector } = await import("../model/mediapipeHeadTailDetector");
        detector = await MediaPipeHeadTailDetector.create(MODEL_PATH);
        if (disposed) {
          detector.close();
          detector = null;
          return;
        }

        setDetection({ status: "active", message: "頭・尾を1秒ごとに端末内で確認しています。", observation: null });

        const infer = () => {
          if (disposed || inferenceInFlight) return;
          if (document.visibilityState !== "visible") {
            setDetection((current) => current.status === "active"
              ? { ...current, status: "paused", message: "画面が非表示のため認識を一時停止しています。", observation: null }
              : current);
            return;
          }

          const video = videoRef.current;
          if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

          inferenceInFlight = true;
          try {
            const observation = detector?.detectVideoFrame(video, performance.now()) ?? null;
            if (observation && !disposed) {
              setDetection({ status: "active", message: "頭・尾を1秒ごとに端末内で確認しています。", observation });
            }
          } catch {
            if (intervalId !== undefined) window.clearInterval(intervalId);
            intervalId = undefined;
            if (!disposed) {
              setDetection({ status: "error", message: "認識処理に失敗しました。カメラを再起動してください。", observation: null });
            }
          } finally {
            inferenceInFlight = false;
          }
        };

        const handleVisibilityChange = () => {
          if (document.visibilityState === "visible" && !disposed) {
            setDetection((current) => current.status === "paused"
              ? { ...current, status: "active", message: "頭・尾を1秒ごとに端末内で確認しています。" }
              : current);
            infer();
          }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        removeVisibilityListener = () => document.removeEventListener("visibilitychange", handleVisibilityChange);
        intervalId = window.setInterval(infer, INFERENCE_INTERVAL_MS);
        infer();
      } catch {
        if (!disposed) {
          setDetection({
            status: modelMissing ? "unavailable" : "error",
            message: modelMissing
              ? "認識モデルが未配置です。mlの学習手順を実行すると検出が有効になります。"
              : "MediaPipeを初期化できませんでした。WASMとモデルの配置を確認してください。",
            observation: null,
          });
        }
      }
    }

    void initialize();

    return () => {
      disposed = true;
      removeVisibilityListener?.();
      if (intervalId !== undefined) window.clearInterval(intervalId);
      try {
        detector?.close();
      } catch {
        // A partially initialized task may already be disposed by MediaPipe.
      }
    };
  }, [enabled, videoRef]);

  return detection;
}
