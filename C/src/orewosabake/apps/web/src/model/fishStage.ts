import type { FishState } from "@orewosabake/contracts";

export const FISH_STAGE_LABELS = ["whole", "head_removed", "gutted", "filleting", "finished"] as const;
export const FISH_STAGE_REJECT_LABEL = "unknown" as const;
export const FISH_STAGE_MODEL_LABELS = [...FISH_STAGE_LABELS, FISH_STAGE_REJECT_LABEL] as const;

export type FishStage = typeof FISH_STAGE_LABELS[number];
export type FishStageTransition = {
  from: FishStage;
  to: FishStage;
  capturedAt: string;
};

export function parseFishStage(label: string): FishStage | null {
  const normalized = label.trim().toLowerCase();
  // The model's optional "unknown" reject class must stay uncertain and never map to a guide state.
  return FISH_STAGE_LABELS.find((stage) => stage === normalized) ?? null;
}

export function stageToExpectedFishState(stage: FishStage): FishState | null {
  switch (stage) {
    case "whole": return "whole_fish";
    case "head_removed": return "head_removed";
    case "gutted": return "opened";
    case "filleting": return "filleting";
    case "finished": return "filleted";
  }
}

export function fishStageLabel(stage: FishStage): string {
  switch (stage) {
    case "whole": return "未処理";
    case "head_removed": return "頭を外した状態";
    case "gutted": return "内臓処理済み";
    case "filleting": return "身を分けている途中";
    case "finished": return "さばき工程の完了状態";
  }
}
