export const RECIPE_ORDER = ["claude", "grok", "openai", "newapi"] as const;
export type RecipeName = (typeof RECIPE_ORDER)[number];
