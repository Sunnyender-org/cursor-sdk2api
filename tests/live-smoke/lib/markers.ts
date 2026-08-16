import { randomBytes } from "node:crypto";

export function opaqueMarker(prefix = "mk"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}
