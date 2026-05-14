/**
 * Global mental model read/write.
 * Storage: mind/model.json
 */
import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { GlobalModel, GlobalModelFile } from "./types.js";

const EMPTY_MODEL: GlobalModel = {
  version: 3,
  generatedAt: new Date().toISOString(),
  cognitiveStyle: "",
  decisionPatterns: [],
  preferences: [],
  guardrails: [],
  emotionalProfile: "",
  relationalNotes: [],
  tokenEstimate: 0,
};

export function modelPath(): string {
  return path.join(CONFIG.paths.v3Mind, "model.json");
}

export function readModel(): GlobalModelFile {
  const filePath = modelPath();
  if (!fs.existsSync(filePath)) {
    return {
      model: { ...EMPTY_MODEL },
      lastCompressorRun: "",
      observationCount: 0,
    };
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function writeModel(file: GlobalModelFile): void {
  const dir = CONFIG.paths.v3Mind;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(modelPath(), JSON.stringify(file, null, 2));
}
