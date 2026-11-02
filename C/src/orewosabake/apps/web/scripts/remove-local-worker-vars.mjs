import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const buildVarsPath = resolve("dist/worker/.dev.vars");
await rm(buildVarsPath, { force: true });
