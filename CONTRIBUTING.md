# Contributing

## Test layers

1. Deterministic contract tests with the injected fake SDK (`tests/contract`, `tests/integration`).
2. Isolated Docker build.
3. Opt-in live smoke only (`tests/live-smoke`). Never put real credentials in fixtures or CI.
4. `integrations/new-api/compose-e2e.sh` is credential-free infrastructure
   evidence. `integrations/new-api/smoke.mjs` is opt-in live-model evidence and
   requires a new-api user token plus locally configured channels.

## Rules

- Official `@cursor/sdk` only. Exact pin. No private H2, browser cookies, or copied gateway internals.
- Fail closed on empty turns, unknown tool IDs, identity mismatch, and usage uncertainty.
- Do not log secrets or raw tool payloads.
- Keep the default profile free of ambient Cursor tools.

## Checks

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run secret:scan
```

For integration or release changes also run:

```bash
bash integrations/new-api/compose-e2e.sh
```

## Release discipline

- Never commit `.env`, rendered channel JSON, Cursor keys, new-api tokens,
  cookies, proxy credentials, `STATE_DIR`, or SQLite state.
- `package.json` is the release version source. A release tag must equal
  `v<package version>`.
- Tags and formal GitHub Releases are maintainer gates. A PR may change the
  dormant workflow but must not create a tag or publish an image.
- Before the next approved tag, bump `package.json`; the published `v0.1.0`
  tag already consumes version `0.1.0`.
- Release CI publishes multi-architecture GHCR images and attaches provenance,
  SBOM, and an immutable digest receipt. Record the digest, not only a tag.
