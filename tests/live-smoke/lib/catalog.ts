export const DEFAULT_LIVE_MODELS = [
  "claude-sonnet-4-6",
  "claude-fable-5",
  "grok-4.6",
  "composer-2.5",
] as const;

export interface CatalogModel {
  id: string;
  display_name?: string;
  displayName?: string;
  aliases?: string[];
  parameters?: Array<{ id: string; values?: Array<{ value: string }> }>;
}

export type ResolveHow = "exact" | "normalized" | "alias" | "alias_normalized" | "missing" | "ambiguous";

export interface CatalogResolve {
  requested: string;
  id?: string;
  how: ResolveHow;
}

export function normalizeModelId(id: string): string {
  return id.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

export function resolveCatalogModel(requested: string, models: CatalogModel[]): CatalogResolve {
  const trimmed = requested.trim();
  if (!trimmed) return { requested, how: "missing" };

  const exact = models.filter((model) => model.id === trimmed);
  if (exact.length === 1) return { requested, id: exact[0]?.id, how: "exact" };
  if (exact.length > 1) return { requested, how: "ambiguous" };

  const reqNorm = normalizeModelId(trimmed);
  const byNormId = models.filter((model) => normalizeModelId(model.id) === reqNorm);
  if (byNormId.length === 1) return { requested, id: byNormId[0]?.id, how: "normalized" };
  if (byNormId.length > 1) return { requested, how: "ambiguous" };

  const byAlias = models.filter((model) => (model.aliases ?? []).includes(trimmed));
  if (byAlias.length === 1) return { requested, id: byAlias[0]?.id, how: "alias" };
  if (byAlias.length > 1) return { requested, how: "ambiguous" };

  const byAliasNorm = models.filter((model) =>
    (model.aliases ?? []).some((alias) => normalizeModelId(alias) === reqNorm),
  );
  if (byAliasNorm.length === 1) return { requested, id: byAliasNorm[0]?.id, how: "alias_normalized" };
  if (byAliasNorm.length > 1) return { requested, how: "ambiguous" };

  return { requested, how: "missing" };
}

export function resolveRequestedModels(
  requested: string[],
  models: CatalogModel[],
): { resolved: CatalogResolve[]; missing: string[]; ambiguous: string[] } {
  const resolved = requested.map((name) => resolveCatalogModel(name, models));
  return {
    resolved,
    missing: resolved.filter((item) => item.how === "missing").map((item) => item.requested),
    ambiguous: resolved.filter((item) => item.how === "ambiguous").map((item) => item.requested),
  };
}

/** Skip only when the catalog explicitly lists parameters and omits this capability. */
export function catalogCapability(
  model: CatalogModel | undefined,
  capability: "thinking",
): "supported" | "unsupported" | "unknown" {
  if (!model) return "unknown";
  const params = model.parameters ?? [];
  if (params.length === 0) return "unknown";
  const ids = params.map((param) => param.id.toLowerCase());
  if (capability === "thinking") {
    return ids.some((id) => id.includes("thinking") || id.includes("reasoning")) ? "supported" : "unsupported";
  }
  return "unknown";
}
