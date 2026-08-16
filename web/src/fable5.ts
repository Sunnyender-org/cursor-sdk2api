import type { ModelsPayload } from "./types.js";

export const FABLE5_DASHBOARD = "https://cursor.com/dashboard/restricted_models/claude-fable-5";
export const FABLE5_DOCS = "https://cursor.com/docs/models/claude-fable-5";

export function modelLooksLikeFable5(id: string, displayName = ""): boolean {
  const haystack = `${id} ${displayName}`.toLowerCase();
  return haystack.includes("fable-5") || haystack.includes("fable 5") || haystack.includes("claude-fable-5");
}

export function catalogHasFable5(models?: ModelsPayload): boolean {
  return Boolean(models?.data.some((model) => modelLooksLikeFable5(model.id, model.display_name)));
}
