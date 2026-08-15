import { createReadStream, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { notFound } from "../errors.js";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function serveConsole(
  res: ServerResponse,
  pathname: string,
  requestId: string,
  consoleDir: string,
  headOnly = false,
): boolean {
  if (pathname === "/console") {
    res.writeHead(308, {
      location: "/console/",
      "cache-control": "no-store",
      "x-request-id": requestId,
    });
    res.end();
    return true;
  }
  if (!pathname.startsWith("/console/")) return false;

  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice("/console/".length));
  } catch {
    throw notFound("Console asset not found");
  }
  if (!relative || relative.endsWith("/")) relative += "index.html";
  if (relative.includes("\0")) throw notFound("Console asset not found");

  const root = resolve(consoleDir);
  const file = resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    throw notFound("Console asset not found");
  }

  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw notFound("Console asset not found");
  }
  if (!stat.isFile()) throw notFound("Console asset not found");

  const immutable = relative.startsWith("assets/");
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": String(stat.size),
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-request-id": requestId,
  });
  if (headOnly) {
    res.end();
    return true;
  }
  const reader = createReadStream(file);
  reader.on("error", () => {
    if (!res.writableEnded) res.destroy();
  });
  res.on("close", () => reader.destroy());
  reader.pipe(res);
  return true;
}
