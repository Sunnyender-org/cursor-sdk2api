# NOTICE

cursor-sdk2api is an independent, MIT-licensed project maintained by Sunnyender-org and contributors.

This project is not affiliated with, endorsed by, or sponsored by Anysphere, Inc. or Cursor.

## Third-party dependency

- `@cursor/sdk` is an npm runtime dependency. It remains the property of its copyright holders and is licensed under the terms shipped in that package (`SEE LICENSE IN LICENSE.md`). This repository does not vendor, patch, or redistribute `@cursor/sdk` source or platform binaries.
- Users must supply their own legally obtained Cursor User API Key or Service Account API Key and must comply with Cursor Terms of Service and applicable law.

## Runtime dependencies

| Package | License | Why it exists | Removal condition |
|---|---|---|---|
| `@cursor/sdk` (exact pin) | Cursor package license | Only Cursor execution engine | Project would have no official runtime |
| `proxy-agent` (exact pin) | MIT | Routes the SDK Agent HTTP/1.1 data plane through an operator-configured HTTP(S) proxy | Official SDK gains equivalent proxy support |
| `undici` (exact pin) | MIT | Routes SDK catalog/account fetches through the same proxy policy | Official SDK fetch surfaces gain equivalent proxy support |

Dev-only packages (TypeScript, Vitest, tsx, `@types/node`) are not shipped in the runtime image except as needed to compile.

## BF Labs UI source components

The optional Operator Console includes selected source components and design tokens from
BF Labs UI, Copyright (c) 2026 BF Labs, used under the MIT License. The copied surface is
maintained in this repository so the standalone gateway does not require a private package
registry at runtime or build time.

## Known production audit findings (2026-08-15)

`npm audit --omit=dev` on `@cursor/sdk@1.0.28`:

| Package | Severity | Notes |
|---|---|---|
| `undici` | high | Transitive via `@connectrpc/connect-node`. Multiple advisories; `fixAvailable: false`. |
| `@connectrpc/connect-node` | moderate | Depends on the vulnerable `undici` range. `fixAvailable: false`. |
| `@cursor/sdk` | moderate | Depends on `@connectrpc/connect-node`. `fixAvailable: false`. |

These are accepted SDK-tree risks for v0.1. Do not run `npm audit fix --force`. Re-check on the next exact SDK pin.
