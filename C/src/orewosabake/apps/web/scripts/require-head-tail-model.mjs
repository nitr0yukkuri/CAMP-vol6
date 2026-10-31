import { open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modelPath = path.join(webDirectory, "public", "models", "head-tail.tflite");
const maxStaticAssetBytes = 25 * 1024 * 1024;

let modelStats;
try {
  modelStats = await stat(modelPath);
} catch {
  console.error(`Cannot deploy: trained model is missing at ${modelPath}. Follow ml/README.md to produce it first.`);
  process.exitCode = 1;
}

if (modelStats) {
  if (!modelStats.isFile() || modelStats.size < 8 || modelStats.size >= maxStaticAssetBytes) {
    console.error(`Cannot deploy: expected a TFLite model smaller than 25 MiB at ${modelPath}.`);
    process.exitCode = 1;
  } else {
    const file = await open(modelPath, "r");
    try {
      const header = Buffer.alloc(8);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || header.toString("ascii", 4, 8) !== "TFL3") {
        console.error(`Cannot deploy: ${modelPath} does not have a valid TFLite FlatBuffer header.`);
        process.exitCode = 1;
      } else {
        console.info(`Deployment model preflight passed (${(modelStats.size / 1024 / 1024).toFixed(1)} MiB, TFLite FlatBuffer).`);
      }
    } finally {
      await file.close();
    }
  }
}
