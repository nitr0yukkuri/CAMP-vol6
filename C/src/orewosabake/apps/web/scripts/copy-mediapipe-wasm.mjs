import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageEntry = fileURLToPath(import.meta.resolve("@mediapipe/tasks-vision"));
const packageDirectory = path.dirname(packageEntry);
const sourceDirectory = path.join(packageDirectory, "wasm");
const destinationDirectory = path.join(webDirectory, "public", "mediapipe", "wasm");
const runtimeFiles = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
];

await mkdir(destinationDirectory, { recursive: true });
await Promise.all(runtimeFiles.map((fileName) =>
  copyFile(path.join(sourceDirectory, fileName), path.join(destinationDirectory, fileName))));

const totalBytes = (await Promise.all(runtimeFiles.map((fileName) =>
  stat(path.join(destinationDirectory, fileName))))).reduce((total, file) => total + file.size, 0);
console.info(`Prepared ${runtimeFiles.length} MediaPipe WASM runtime files (${(totalBytes / 1024 / 1024).toFixed(1)} MiB).`);
